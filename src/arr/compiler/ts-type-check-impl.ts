import type * as TS from './ts-type-structs';
import type * as A from './ts-ast';
import type * as SL from './ts-srcloc';
import type * as CS from './ts-compile-structs';
import type * as TJ from './ts-codegen-helpers';
import type * as TCS from './ts-type-check-structs';
import type * as TCSH from './ts-compile-structs-helpers';
import type { List, MutableStringDict, PFunction, StringDict, Option } from './ts-impl-types';

type SDExports = {
  dict: { values: { dict: {
    'make-mutable-string-dict': PFunction<<T>() => MutableStringDict<T>>
    'is-mutable-string-dict': PFunction<(val: any) => boolean>,
    'make-string-dict': PFunction<<T>() => StringDict<T>>,
    'is-string-dict': PFunction<(val: any) => boolean>,
    'map-keys': PFunction<<T, U>(f: ((key: T) => U), isd: StringDict<T>) => List<U>>,
    'map-keys-now': PFunction<<T, U>(f: ((key: T) => U), msd: MutableStringDict<T>) => List<U>>,
    'fold-keys': PFunction<<T, U>(f: (key: string, acc: U) => U, init: U, isd: StringDict<T>) => U>,
    'fold-keys-now': PFunction<<T, U>(f: (key: string, acc: U) => U, init: U, msd: MutableStringDict<T>) => U>,
    'each-key': PFunction<<T>(f: ((key: T) => void), isd: StringDict<T>) => void>,
    'each-key-now': PFunction<<T>(f: ((key: T) => void), msd: MutableStringDict<T>) => void>,
  }}}
}

({
  requires: [
    { 'import-type': 'builtin', name: 'string-dict' },
    { 'import-type': 'builtin', name: 'srcloc'},
    { 'import-type': 'dependency', protocol: 'js-file', args: ['ts-codegen-helpers']},
    { 'import-type': 'dependency', protocol: 'js-file', args: ['ts-compile-structs-helpers']},
    { 'import-type': 'dependency', protocol: 'file', args: ['type-structs.arr']},
    { 'import-type': 'dependency', protocol: 'file', args: ['ast.arr']},
    { 'import-type': 'dependency', protocol: 'file', args: ['compile-structs.arr']},
    { 'import-type': 'dependency', protocol: 'file', args: ['type-check-structs.arr']},
    { 'import-type': 'dependency', protocol: 'file', args: ['type-defaults.arr']},
 ],
  nativeRequires: ["escodegen", "path"],
  provides: {
    values: {
      "type-check": "tany"
    }
  },
  theModule: function(runtime, _, __, SDin: SDExports, SL : SL.Exports, tj : TJ.Exports, TCSH : (TCSH.Exports), TSin : (TS.Exports), A : (A.Exports), CSin : (CS.Exports), TCS : (TCS.Exports)) {
    const SD = SDin.dict.values.dict;
    const {
      ExhaustiveSwitchError,
      InternalCompilerError,
      listToArray,
      nameToKey,
      nameToName,
      sameName,
      formatSrcloc,
      map,
    } = tj;
    const { builtin } = SL.dict.values.dict;
    const TS = TSin.dict.values.dict;
    const builtinUri = TS['module-uri'].app("builtin://global");
    const {
      globalValueValue,
      callMethod,
      unwrap,
      providesByUri,
      valueByUriValue,
      resolveDatatypeByUriValue,
      typeByUri,
    } = TCSH;
    const CS = CSin.dict.values.dict;
    const { 's-global': sGlobal, 's-type-global': sTypeGlobal } = A.dict.values.dict;
    const { 
      typed,
      'tc-info': tcInfo,
      'empty-info': emptyInfo,
      'empty-context': emptyContext,
      'fold-result': foldResult,
      'fold-errors': foldErrors,
      "typing-context": typingContext
    } = TCS.dict.values.dict;
    
    class TypeCheckFailure extends Error {
      constructor(...errs : CS.CompileError[]) {
        super("type error " + require('util').inspect(errs));
      }
    }

    function foldrFoldResult<X, Y>(f : (x: X, context: TCS.Context, acc: Y) => TCS.FoldResult<Y>, xs: X[], context: TCS.Context, base: Y): TCS.FoldResult<Y> {
      return xs.reduceRight((prev: TCS.FoldResult<Y>, cur: X): TCS.FoldResult<Y> => {
        switch(prev.$name) {
          case 'fold-errors': return prev;
          case 'fold-result': {
            return f(cur, prev.dict.context, prev.dict.v);
          }
          default: throw new ExhaustiveSwitchError(prev);
        }
      }, foldResult.app(base, context));
    }

    function gatherProvides(provide: A.ProvideBlock, context: TCS.Context): TCS.TCInfo {
      switch(provide.$name) {
        case 's-provide-block': {
          const curTypes = SD['make-mutable-string-dict'].app<TS.Type>();
          const curAliases = callMethod(context.dict.info.dict.aliases, 'unfreeze');
          const curData = callMethod(context.dict.info.dict['data-types'], 'unfreeze');
          // Note(Ben): I'm doing two things differently than the original Pyret code:
          // 1. I'm traversing the list of specs from first to last.  If this ultimately matters,
          //    we could reverse the array on the next line before traversing it.
          // 2. I'm mutably updatng the three dictionaries object above, rather than functionally 
          //    folding over a `TCInfo` object.  Since the original code never produced `fold-errors`
          //    objects, it's not necessary to mimic all of foldr-fold-result here.
          for (const spec of listToArray(provide.dict.specs)) {
            switch(spec.$name) {
              case 's-provide-name': {
                const nameSpec = spec.dict['name-spec'];
                switch(nameSpec.$name) {
                  case 's-local-ref': {
                    const valueKey = nameToKey(nameSpec.dict.name);
                    if (callMethod(curTypes, 'has-key-now', valueKey)) {
                      break; // nothing more to do
                    } else {
                      // MARK(joe): test as-name here; it appears unused
                      const getValueFromContext = callMethod(context.dict.info.dict.types, 'get', valueKey);
                      switch(getValueFromContext.$name) {
                        case 'some': {
                          const typ = setInferred(getValueFromContext.dict.value, false);
                          callMethod(curTypes, 'set-now', valueKey, typ);
                          break;
                        }
                        case 'none': {
                          const typ = setInferred(callMethod(context.dict['global-types'], 'get-value', valueKey), false);
                          callMethod(curTypes, 'set-now', valueKey, typ);
                          break;
                        }
                        default: throw new ExhaustiveSwitchError(getValueFromContext);
                      }
                    }
                  }
                  case 's-remote-ref': break;
                  case 's-module-ref':
                  case 's-star': throw new InternalCompilerError(`Unexpected require spec type ${spec.$name} / ${nameSpec.$name}`);
                  default: throw new ExhaustiveSwitchError(nameSpec);
                }
                break;
              }
              case 's-provide-type': {
                const nameSpec = spec.dict['name-spec'];
                switch(nameSpec.$name) {
                  case 's-local-ref': {
                    const aliasKey = nameToKey(nameSpec.dict.name);
                    if (callMethod(curAliases, 'has-key-now', aliasKey)) {
                      break; // nothing to do
                    } else {
                      const typ = callMethod(context.dict.aliases, 'get-value', aliasKey);
                      callMethod(curAliases, 'set-now', aliasKey, typ);
                      break;
                    }
                  }
                  case 's-remote-ref': break;
                  case 's-module-ref':
                  case 's-star': throw new InternalCompilerError(`Unexpected require spec type ${spec.$name} / ${nameSpec.$name}`);
                  default: throw new ExhaustiveSwitchError(nameSpec);
                }
                break;
              }
              case 's-provide-module': {
                break; // nothing to do here
              }
              case 's-provide-data': {
                const nameSpec = spec.dict['name-spec'];
                switch(nameSpec.$name) {
                  case 's-local-ref': {
                    const dataKey = nameToKey(nameSpec.dict.name);
                    if (callMethod(curData, 'has-key-now', dataKey)) {
                      break; // nothing to do
                    } else {
                      const typ = callMethod(context.dict['data-types'], 'get-value', dataKey);
                      callMethod(curData, 'set-now', dataKey, typ);
                      break;
                    }
                  }
                  case 's-remote-ref': break;
                  case 's-module-ref':
                  case 's-star': throw new InternalCompilerError(`Unexpected require spec type ${spec.$name} / ${nameSpec.$name}`);
                  default: throw new ExhaustiveSwitchError(nameSpec);
                }
                break;
              }
              default: throw new ExhaustiveSwitchError(spec);
            }
          }
          return tcInfo.app(
            callMethod(curTypes, 'freeze'),
            callMethod(curAliases, 'freeze'),
            callMethod(curData, 'freeze'));
        }
        default: throw new ExhaustiveSwitchError(provide.$name);
      }
    }

    class ConstraintSystem {

    }

    class TCInfo {

    }
    class Context {
      globalTypes : Map<string, TS.Type>;     // global name -> type
      aliases : Map<string, TS.Type>;         // t-name -> aliased type
      dataTypes : Map<string, TS.DataType>;   // t-name -> data type
      modules : Map<string, TS.ModuleType>;   // module name -> module type
      moduleNames : Map<string, string>;      // imported name -> module name
      binds : Map<string, TS.Type>;           // local name -> type
      constraints : ConstraintSystem;         // constraints should only be added with methods to ensure that they have the proper forms
      info : TCInfo;
      misc : Map<string, [TS.Type[], string]> // miscellaneous info that is used for logging. Keyed by the function name

      constructor(
        globalTypes: Map<string, TS.Type>, 
        aliases: Map<string, TS.Type>,
        dataTypes: Map<string, TS.DataType>,
        modules: Map<string, TS.ModuleType>,
        moduleNames: Map<string, string>
      ) {
        this.globalTypes = globalTypes;
        this.aliases = aliases;
        this.dataTypes = dataTypes;
        this.modules = modules;
        this.moduleNames = moduleNames;
      }

      addLevel() : void {

      }
    }   

    function resolveAlias(t : TS.Type, c : Context) : TS.Type {
      return t;
    }

    function mapFromStringDict<T>(s : StringDict<T>) : Map<string, T> {
      const m : Map<string, T> = new Map();
      for (let valKey of listToArray(callMethod(s, 'keys-list'))) {
        m.set(valKey, callMethod(s, "get-value", valKey));
      }
      return m;
    }
    function mapFromMutableStringDict<T>(s : MutableStringDict<T>) : Map<string, T> {
      const m : Map<string, T> = new Map();
      for (let valKey of listToArray(callMethod(s, 'keys-list-now'))) {
        m.set(valKey, callMethod(s, "get-value-now", valKey));
      }
      return m;
    }

    function stringDictFromMap<T>(m : Map<string, T>): StringDict<T> {
      return callMethod(mutableStringDictFromMap(m), 'freeze');
    }
    function mutableStringDictFromMap<T>(m : Map<string, T>): MutableStringDict<T> {
      const s = SD['make-mutable-string-dict'].app<T>();
      for (const [k, v] of m.entries()) {
        callMethod(s, 'set-now', k, v);
      }
      return s;
    }

    function setTypeLoc(type: TS.Type, loc: SL.Srcloc): TS.Type {
      const newType = map({}, type);
      newType.dict.l = loc;
      return newType;
    }

    function setInferred(type: TS.Type, inferred: boolean): TS.Type {
      const newType = map({}, type);
      newType.dict.inferred = inferred;
      return newType;
    }

    function substitute(type: TS.Type, newType: TS.Type, typeVar: TS.Type): TS.Type {
      switch(type.$name) {
        case 't-name': return type;
        case 't-arrow': {
          const { args, ret, l, inferred } = type.dict;
          const newArgs = listToArray(args).map((t) => substitute(t, newType, typeVar));
          const newRet = substitute(ret, newType, typeVar);
          return TS['t-arrow'].app(runtime.ffi.makeList(newArgs), newRet, l, inferred);
        }
        case 't-app': {
          const { args, onto, l, inferred } = type.dict;
          const newArgs = listToArray(args).map((t) => substitute(t, newType, typeVar));
          const newOnto = substitute(onto, newType, typeVar);
          return TS['t-app'].app(newOnto, runtime.ffi.makeList(newArgs), l, inferred);
        }
        case 't-top': return type;
        case 't-bot': return type;
        case 't-record': {
          const { fields, l, inferred } = type.dict;
          const newFields = mapFromStringDict(fields);
          for (const key of newFields.keys()) {
            newFields.set(key, substitute(newFields.get(key), newType, typeVar));
          }
          return TS['t-record'].app(stringDictFromMap(newFields), l, inferred);
        }
        case 't-tuple': {
          const { elts, l, inferred } = type.dict;
          const newElts = listToArray(elts).map((t) => substitute(t, newType, typeVar));
          return TS['t-tuple'].app(runtime.ffi.makeList(newElts), l, inferred);
        }
        case 't-forall': {
          // Note: doesn't need to be capture-avoiding thanks to resolve-names
          const { introduces, onto, l, inferred } = type.dict;
          const newOnto = substitute(onto, newType, typeVar);
          return TS['t-forall'].app(introduces, newOnto, l, inferred);
        }
        case 't-ref': {
          const { typ, l, inferred } = type.dict;
          const newTyp = substitute(typ, newType, typeVar);
          return TS['t-ref'].app(newTyp, l, inferred);
        }
        case 't-data-refinement': {
          const { "data-type": dataType, "variant-name": variantName, l, inferred } = type.dict;
          const newDataType = substitute(dataType, newType, typeVar);
          return TS['t-data-refinement'].app(newDataType, variantName, l, inferred);
        }
        case 't-var': {
          switch(typeVar.$name) {
            case 't-var': {
              if (sameName(type.dict.id, typeVar.dict.id)) {
                return setTypeLoc(newType, type.dict.l);
              } else {
                return type;
              }
            }
            default: return type;
          }
        }
        case 't-existential': {
          switch(typeVar.$name) {
            case 't-existential': {
              // inferred existentials keep their locations
              // this is along the lines of inferred argument types etc
              // uninferred existentials are used to equate different pieces of code
              // they should not keep their location
              if (sameName(type.dict.id, typeVar.dict.id)) {
                if (type.dict.inferred) {
                  return setTypeLoc(newType, type.dict.l);
                } else {
                  return newType;
                }
              } else {
                return type;
              }
            }
            default: return type;
          }
        }
        default: throw new ExhaustiveSwitchError(type);
      }
    }

    function simplifyTApp(appType : TJ.Variant<TS.Type, "t-app">, context : Context) : TS.Type {
      const args = listToArray(appType.dict.args);
      const onto = resolveAlias(appType.dict.onto, context);
      switch(onto.$name) {
        case 't-forall': {
          const introduces = listToArray(onto.dict.introduces);
          if (args.length !== introduces.length) {
            throw new TypeCheckFailure(CS['bad-type-instantiation'].app(appType, introduces.length));
          }
          let newOnto: TS.Type = onto;
          for (let i = 0; i < args.length; i++) {
            newOnto = substitute(newOnto, args[i], introduces[i]);
          }
          return newOnto;
        }
        case 't-app': {
          const newOnto = simplifyTApp(onto, context);
          return simplifyTApp(
            TS['t-app'].app(newOnto, appType.dict.args, appType.dict.l, appType.dict.inferred), 
            context);
        }
        default: throw new TypeCheckFailure(CS['bad-type-instantiation'].app(appType, 0));
      }
    }

    function checking(e : A.Expr, expectTyp : TS.Type, topLevel : boolean, context : Context) : void {
      return _checking(e, expectTyp, topLevel, context);
    }

    function _checking(e : A.Expr, expectTyp : TS.Type, topLevel : boolean, context : Context) : void {
      context.addLevel();
      expectTyp = resolveAlias(expectTyp, context);
      return null;
    }

    function synth(e : A.Expr, topLevel : boolean, context : TCS.Context) : TS.Type {
      return null;
    }

    function _synth(e : A.Expr, topLevel : boolean, context : TCS.Context) : TS.Type {
      return null;
    }

    function typeCheck(program: A.Program, compileEnv : CS.CompileEnvironment, postCompileEnv : CS.ComputedEnvironment, modules : MutableStringDict<CS.Loadable>, options) {
      // DEMO output: options.dict.log.app("Hi!", runtime.ffi.makeNone());
      const provides = listToArray(program.dict.provides);
      let context = emptyContext;

      const globVs = compileEnv.dict.globals.dict.values;
      const globTs = compileEnv.dict.globals.dict.types;

      const contextGlobTs = callMethod(context.dict['aliases'], 'unfreeze');
      const contextGlobVs = callMethod(context.dict['global-types'], 'unfreeze');
      const contextGlobMods = SD["make-mutable-string-dict"].app<TS.ModuleType>();
      const contextGlobDTs = SD["make-mutable-string-dict"].app<TS.DataType>();

      for (const g of listToArray(callMethod(globVs, 'keys-list'))) {
        const key = nameToKey(sGlobal.app(g));
        if (callMethod(contextGlobVs, 'has-key-now', key)) {
          continue;
        }
        else {
          if(g === "_") {
            continue;
          }
          else {
            const ve =  globalValueValue(compileEnv, g);
            callMethod(contextGlobVs, 'set-now', key, ve.dict.t);
          }
        }
      }

      for (const g of listToArray(callMethod(globTs, "keys-list"))) {
        const key = nameToKey(sTypeGlobal.app(g));
        if (callMethod(contextGlobTs, 'has-key-now', key)) {
          continue;
        }
        else {
          const origin = callMethod(globTs, 'get-value', g);
          if (g === "_") { continue; }
          else {
            const provs = unwrap(providesByUri(compileEnv, origin.dict['uri-of-definition']),
                `Could not find module ${origin.dict['uri-of-definition']} in ${listToArray(callMethod(compileEnv.dict['all-modules'], 'keys-list-now'))} at ${formatSrcloc(program.dict.l, true)}}`);
            let t: TS.Type;
            const alias = callMethod(provs.dict.aliases, 'get', g);
            switch(alias.$name) {
              case 'some': { t = alias.dict.value; break; }
              case 'none': {
                const dd = callMethod(provs.dict['data-definitions'], 'get', g);
                switch(dd.$name) {
                  case 'none':
                    // Note(Ben): could use `unwrap(callMethod(...))` above, but since this
                    // error message is expensive to compute, I didn't.
                    const keys = [
                      ...listToArray(callMethod(provs.dict.aliases, 'keys-list')),
                      ...listToArray(callMethod(provs.dict['data-definitions'], 'keys-list'))
                    ];
                    throw new InternalCompilerError(`Key ${g} not found in ${keys}`);
                  case 'some':
                    t = TS['t-name'].app(builtinUri, sTypeGlobal.app(g), builtin.app("global"), false);
                    break;
                  default: throw new ExhaustiveSwitchError(dd, "computing aliases from data defs");
                }
                break;
              }
              default: throw new ExhaustiveSwitchError(alias, "computing aliases");
            }
            callMethod(contextGlobTs, 'set-now', key, t);
          }
        }
      }

      for (let k of listToArray(callMethod(modules, 'keys-list-now'))) {
        if (callMethod(context.dict.modules, 'has-key', k)) {
          continue;
        }
        else {
          // NOTE/TODO/REVISIT(joe/ben/luna): Can we just resolve these with valueByUriValue/resolveDatatypeByUriValue
          const mod = callMethod(modules, 'get-value-now', k).dict.provides;
          const key = mod.dict['from-uri'];
          let valsTypesDict = SD['make-string-dict'].app<TS.Type>();
          for (let valKey of listToArray(callMethod(mod.dict.values, 'keys-list'))) {
            let typ : TS.Type;
            const ve = callMethod(mod.dict.values, 'get-value', valKey);
            switch(ve.$name) {
              case 'v-alias':
                const { origin } = ve.dict;
                typ = valueByUriValue(compileEnv, origin.dict['uri-of-definition'], nameToName(origin.dict['original-name'])).dict.t;
                break;
              default:
                typ = ve.dict.t;
            }
            valsTypesDict = callMethod(valsTypesDict, 'set', valKey, typ);
          }
          let dataDict = SD["make-string-dict"].app<TS.DataType>();
          for (let dataKey of listToArray(callMethod(mod.dict['data-definitions'], 'keys-list'))) {
            const de = callMethod(mod.dict['data-definitions'], 'get-value', dataKey);
            let typ : TS.DataType;
            switch(de.$name) {
              case 'd-alias':
                const { origin } = de.dict;
                typ = resolveDatatypeByUriValue(compileEnv, origin.dict['uri-of-definition'], nameToName(origin.dict['original-name']));
                break;
              default:
                typ = de.dict.typ;
            }
            dataDict = callMethod(dataDict, 'set', dataKey, typ);
          }
          const valProvides = TS['t-record'].app(valsTypesDict, program.dict.l, false);
          const moduleType = TS['t-module'].app(key, valProvides, dataDict, mod.dict.aliases);
          callMethod(contextGlobMods, 'set-now', key, moduleType);
          for(let dataKey of listToArray(callMethod(mod.dict['data-definitions'], 'keys-list'))) {
            // NOTE(joe): changed this to byUri***Value*** to not return an
            // Option, which conflicted with the type of the data-types field of
            // context (but evidently never triggered a dynamic error in our tests)
            const resolved = resolveDatatypeByUriValue(compileEnv, key, dataKey);
            callMethod(contextGlobDTs, 'set-now', dataKey, resolved);
          }
        }
      }

      if(postCompileEnv.$name === "computed-none") {
        throw new InternalCompilerError(`type-check got computed-none postCompileEnv in ${formatSrcloc(program.dict.l, true)}`);
      }

      const mbinds = postCompileEnv.dict['module-bindings'];
      const vbinds = postCompileEnv.dict.bindings;
      const tbinds = postCompileEnv.dict['type-bindings'];

      const contextGlobModnames = callMethod(context.dict['module-names'], 'unfreeze');

      for (let key of listToArray(callMethod(mbinds, 'keys-list-now'))) {
        callMethod(contextGlobModnames, 'set-now', key, callMethod(mbinds, 'get-value-now', key).dict.uri);
      }

      for (let key of listToArray(callMethod(vbinds, 'keys-list-now'))) {
        const vbind = callMethod(vbinds, 'get-value-now', key);
        if (vbind.dict.origin.dict['new-definition']) { continue; }
        else {
          const thismod = callMethod(contextGlobMods, 'get-value-now', vbind.dict.origin.dict['uri-of-definition']);
          const originalName = nameToName(vbind.dict.origin.dict['original-name']);
          const field = unwrap(callMethod(thismod.dict.provides.dict.fields, 'get', originalName), `Cannot find value bind for ${originalName} in ${formatSrcloc(program.dict.l, true)}`);
          callMethod(contextGlobVs, 'set-now', key, field);
        }
      }

      for (let key of listToArray(callMethod(tbinds, 'keys-list-now'))) {
        const tbind = callMethod(tbinds, 'get-value-now', key);
        const origin = tbind.dict.origin;
        if (origin.dict['new-definition']) { continue; }
        else {
          const originalName = nameToName(origin.dict['original-name']);
          const originalType = unwrap(
            typeByUri(compileEnv, origin.dict['uri-of-definition'], originalName),
            `Cannot find type bind for ${originalName} in ${formatSrcloc(program.dict.l, true)}`);
          callMethod(contextGlobTs, 'set-now', key, originalType)
        }
      }


      const contextFromModulesToBeReplaced = typingContext.app(
          callMethod(contextGlobVs, 'freeze'),
          callMethod(contextGlobTs, 'freeze'),
          callMethod(contextGlobDTs, 'freeze'),
          callMethod(contextGlobMods, 'freeze'),
          callMethod(contextGlobModnames, 'freeze'),
          context.dict['binds'],
          context.dict['constraints'],
          context.dict['info'],
          context.dict['misc'],
      )

      const contextFromModules = new Context(
        mapFromMutableStringDict(contextGlobVs),
        mapFromMutableStringDict(contextGlobTs),
        mapFromMutableStringDict(contextGlobDTs),
        mapFromMutableStringDict(contextGlobMods),
        mapFromMutableStringDict(contextGlobModnames));

      try {
        checking(program.dict.block, TS['t-top'].app(program.dict.l, false), true, contextFromModules);
      }
      catch(e) {
        console.error("Got a type-checking error", e);
      }

      const info = gatherProvides(provides[0], contextFromModulesToBeReplaced);
      return CS.ok.app(typed.app(program, info));
    }
    return runtime.makeModuleReturn({
      'type-check': runtime.makeFunction(typeCheck)
    }, {});
  }
})