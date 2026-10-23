/**
 * C++ N-API addon emitter.
 *
 * The addon exports flat native functions; it defines no JS classes itself. For
 * each GObject class it exports a spec object (`{ gtype, construct, methods,
 * statics, accessors }`) that the generated entry point installs on a plain JS
 * class (see {@link ./js}). Instance members read `self` from `this` through the
 * runtime ABI (`girbind.hxx`), which checks the GType, so a member defined once
 * works on every subclass instance, including subclasses from other namespaces.
 *
 * The emitter is a set of generator functions: each `yield`s lines of C++ and
 * the top-level {@link generate} joins them. Emitted code is tab-indented.
 */

import type { Class, Func, Namespace, Parameter, Property, ReturnValue, TypeRef } from '../ir.js';
import {
	factoryName,
	functionExportNames,
	isSupported,
	methodName,
	primaryConstructor,
	secondaryConstructors,
} from '../names.js';
import type { Repository } from '../parse.js';
import { type ObjectType, shortName, TypeContext } from '../types.js';

type Lines = Generator<string, void, void>;

/** Indent a block of already-rendered lines by one tab. */
function* indent(...lines: string[]): Lines {
	for (const line of lines) yield line === '' ? '' : '\t' + line;
}

/** Delegate to `lines`, indenting each by one tab, and return its result. */
function* indented<T>(lines: Generator<string, T, void>): Generator<string, T, void> {
	let next = lines.next();
	while (!next.done) {
		yield next.value === '' ? '' : '\t' + next.value;
		next = lines.next();
	}
	return next.value;
}

/** Classes the addon binds: GObject classes only (fundamental types are not GObjects), each after its parent. */
export function boundClasses(ctx: TypeContext): Class[] {
	const classes = ctx.ns.classes.filter(cls => ctx.isGObjectClass(cls));
	const ordered: Class[] = [];
	const placed = new Set<Class>();
	const place = (cls: Class) => {
		if (placed.has(cls)) return;
		placed.add(cls);
		const parent = cls.parent ? ctx.ourClass(cls.parent) : undefined;
		if (parent && classes.includes(parent)) place(parent);
		ordered.push(cls);
	};
	for (const cls of classes) place(cls);
	return ordered;
}

const methods = (cls: Class) => cls.methods.filter(isSupported);
const statics = (cls: Class) => cls.staticMethods.filter(isSupported);

/** Properties exposed as accessors: those not shadowed by a method of the same JS name. */
function properties(cls: Class): Property[] {
	const taken = new Set([...methods(cls), ...statics(cls)].map(methodName));
	return cls.properties.filter(p => !taken.has(propJsName(p)));
}

function propId(p: Property): string {
	return p.name.replace(/-/g, '_');
}

function propJsName(p: Property): string {
	return p.name.replace(/-/g, '_').replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Whether a parameter is the trailing `GError**` that GIRs without `throws` still list. */
function isErrorParam(p: Parameter): boolean {
	return p.type.cType.replace(/\s/g, '') === 'GError**';
}

function errorParam(func: Func): string | undefined {
	return func.throws || func.parameters.some(isErrorParam) ? 'error' : undefined;
}

/** The `ObjectType` of one of this namespace's classes. */
function ownType(ctx: TypeContext, cls: Class): ObjectType {
	return ctx.objectType(cls.name)!;
}

function selfLocal(ctx: TypeContext, cls: Class): string {
	const type = ownType(ctx, cls);
	return `${cls.cName}* self = girbind::unwrap_object<${cls.cName}>(info.This(), ${ctx.gtypeExpression(type)}, "${type.qualified}");`;
}

/** Lines that throw when `err` is set after a C call. */
function* errorCheck(err: string): Lines {
	yield `if (${err}) {`;
	yield `\tNapi::Error js_error = Napi::Error::New(env, ${err}->message);`;
	yield `\tg_error_free(${err});`;
	yield '\tthrow js_error;';
	yield '}';
}

/** Build a C call expression: `<lhs>(<params>[, &error]);`. */
function callExpr(lhs: string, cppParams: string[], err: string | undefined): string {
	let call = `${lhs}(${cppParams.join(', ')}`;
	if (err) call += (cppParams.length ? ', &' : '&') + err;
	return call + ');';
}

// --- class members ----------------------------------------------------------

function* construct(ctx: TypeContext, cls: Class, func: Func): Lines {
	yield `Napi::Value construct_${cls.name}(const Napi::CallbackInfo& info) {`;
	yield '\tNapi::Env env = info.Env();';
	const cppParams: string[] = [];
	yield* indent(...emitParams(ctx, func, [], cppParams));
	const err = errorParam(func);
	if (err) yield `\tGError* ${err} = NULL;`;
	yield `\t${callExpr(`gpointer handle = ${func.cName}`, cppParams, err)}`;
	if (err) yield* indent(...errorCheck(err));
	yield '\tif (!handle) {';
	yield `\t\tthrow Napi::Error::New(env, "${func.cName} returned NULL");`;
	yield '\t}';
	yield `\treturn girbind::object_handle(env, handle, ${func.returnValue.transfer !== 'none'});`;
	yield '}';
	yield '';
}

function* factory(ctx: TypeContext, cls: Class, func: Func): Lines {
	yield `Napi::Value ${cls.name}_factory_${factoryName(func)}(const Napi::CallbackInfo& info) {`;
	yield '\tNapi::Env env = info.Env();';
	const cppParams: string[] = [];
	yield* indent(...emitParams(ctx, func, [], cppParams));
	const err = errorParam(func);
	if (err) yield `\tGError* ${err} = NULL;`;
	yield `\t${callExpr(`gpointer handle = ${func.cName}`, cppParams, err)}`;
	if (err) yield* indent(...errorCheck(err));
	yield `\treturn girbind::wrap_object(env, handle, ${func.returnValue.transfer !== 'none'});`;
	yield '}';
	yield '';
}

function* method(ctx: TypeContext, cls: Class, func: Func): Lines {
	yield `Napi::Value ${cls.name}_${methodName(func)}(const Napi::CallbackInfo& info) {`;
	yield '\tNapi::Env env = info.Env();';
	yield `\t${selfLocal(ctx, cls)}`;
	yield* indent(...callAndReturn(ctx, func, ['self']));
	yield '}';
	yield '';
}

function* staticMethod(ctx: TypeContext, cls: Class, func: Func): Lines {
	yield `Napi::Value ${cls.name}_static_${methodName(func)}(const Napi::CallbackInfo& info) {`;
	yield '\tNapi::Env env = info.Env();';
	yield* indent(...callAndReturn(ctx, func, []));
	yield '}';
	yield '';
}

function* standalone(ctx: TypeContext, func: Func): Lines {
	yield `Napi::Value Wrap_${func.cName}(const Napi::CallbackInfo& info) {`;
	yield '\tNapi::Env env = info.Env();';
	yield* indent(...callAndReturn(ctx, func, []));
	yield '}';
	yield '';
}

/** Find the instance method implementing a property accessor, searching this namespace's hierarchy from `cls`. */
function accessorMethod(ctx: TypeContext, cls: Class, methodGirName: string | undefined): Func | undefined {
	if (!methodGirName) return undefined;
	for (
		let current: Class | undefined = cls;
		current;
		current = current.parent ? ctx.ourClass(current.parent) : undefined
	) {
		const found = current.methods.find(m => m.name === methodGirName);
		if (found) return found;
	}
	return undefined;
}

function hasSetter(ctx: TypeContext, cls: Class, p: Property): boolean {
	if (!p.writable) return false;
	if (accessorMethod(ctx, cls, p.setter)) return true;
	return !p.constructOnly;
}

/** Parameters of a function other than `self` and the trailing `GError**`. */
function valueParams(func: Func): Parameter[] {
	return func.parameters.filter(sp => !sp.isInstance && !isErrorParam(sp));
}

function* accessors(ctx: TypeContext, cls: Class, p: Property): Lines {
	const getterCandidate = accessorMethod(ctx, cls, p.getter);
	const getter =
		getterCandidate && isSupported(getterCandidate) && !valueParams(getterCandidate).length
			? getterCandidate
			: undefined;
	const setterCandidate = accessorMethod(ctx, cls, p.setter);
	const setter =
		setterCandidate && isSupported(setterCandidate) && valueParams(setterCandidate).length === 1
			? setterCandidate
			: undefined;

	if (p.readable) {
		yield `Napi::Value ${cls.name}_get_${propId(p)}(const Napi::CallbackInfo& info) {`;
		yield '\tNapi::Env env = info.Env();';
		yield `\t${selfLocal(ctx, cls)}`;
		if (getter) {
			const err = errorParam(getter);
			if (err) yield `\tGError* ${err} = NULL;`;
			yield `\t${callExpr(`auto value = ${getter.cName}`, [`(${getter.parameters[0]?.type.cType || `${cls.cName}*`})self`], err)}`;
			if (err) yield* indent(...errorCheck(err));
			yield* indent(
				...convertToJs(ctx, getter.returnValue.type, getter.returnValue.transfer, 'value', v => `return ${v};`)
			);
		} else {
			yield '\t(void)self;';
			yield `\t// TODO: read property "${p.name}" via g_object_get (no getter method in GIR)`;
			yield '\treturn env.Null();';
		}
		yield '}';
		yield '';
	}

	if (!hasSetter(ctx, cls, p)) return;
	yield `Napi::Value ${cls.name}_set_${propId(p)}(const Napi::CallbackInfo& info) {`;
	yield '\tNapi::Env env = info.Env();';
	yield `\t${selfLocal(ctx, cls)}`;
	if (setter) {
		const value = yield* indented(fromJs(ctx, valueParams(setter)[0], 'info[0]', 'value'));
		const err = errorParam(setter);
		if (err) yield `\tGError* ${err} = NULL;`;
		yield `\t${callExpr(setter.cName, [`(${setter.parameters[0]?.type.cType || `${cls.cName}*`})self`, value], err)}`;
		if (err) yield* indent(...errorCheck(err));
	} else {
		yield '\t(void)self;';
		yield `\t// TODO: write property "${p.name}" via g_object_set (no setter method in GIR)`;
	}
	yield '\treturn env.Undefined();';
	yield '}';
	yield '';
}

function* classDef(ctx: TypeContext, cls: Class): Lines {
	const primary = primaryConstructor(cls.constructors);
	if (primary && isSupported(primary)) yield* construct(ctx, cls, primary);
	for (const f of secondaryConstructors(cls.constructors).filter(isSupported)) yield* factory(ctx, cls, f);
	for (const f of statics(cls)) yield* staticMethod(ctx, cls, f);
	for (const f of methods(cls)) yield* method(ctx, cls, f);
	for (const p of properties(cls)) yield* accessors(ctx, cls, p);
	yield* classDefinition(ctx, cls);
}

/** The function defining a class on `parent`, with its members, and registering it with the runtime. */
function* classDefinition(ctx: TypeContext, cls: Class): Lines {
	const primary = primaryConstructor(cls.constructors);
	const construct = primary && isSupported(primary) ? `construct_${cls.name}` : 'nullptr';
	yield `const girbind::ClassInfo info_${cls.name} = {"${cls.name}", ${construct}};`;
	for (const p of properties(cls)) {
		const get = p.readable ? `${cls.name}_get_${propId(p)}` : 'nullptr';
		const set = hasSetter(ctx, cls, p) ? `${cls.name}_set_${propId(p)}` : 'nullptr';
		yield `const girbind::Accessor ${cls.name}_accessor_${propId(p)} = {${get}, ${set}};`;
	}
	yield '';
	yield `Napi::Function define_${cls.name}(Napi::Env env, Napi::Function parent) {`;
	yield `\tNapi::Function cls = girbind::define_class(env, info_${cls.name}, "${ctx.typeName(ownType(ctx, cls))}", parent);`;
	yield '\tNapi::Object prototype = cls.Get("prototype").As<Napi::Object>();';
	for (const f of methods(cls)) {
		yield `\tgirbind::define_method(prototype, "${methodName(f)}", ${cls.name}_${methodName(f)});`;
	}
	for (const p of properties(cls)) {
		yield `\tgirbind::define_accessor(prototype, "${propJsName(p)}", ${cls.name}_accessor_${propId(p)});`;
	}
	for (const f of secondaryConstructors(cls.constructors).filter(isSupported)) {
		yield `\tgirbind::define_method(cls, "${factoryName(f)}", ${cls.name}_factory_${factoryName(f)});`;
	}
	for (const f of statics(cls)) {
		yield `\tgirbind::define_method(cls, "${methodName(f)}", ${cls.name}_static_${methodName(f)});`;
	}
	yield '\treturn cls;';
	yield '}';
	yield '';
}

// --- call + conversion ------------------------------------------------------

/** A non-pointer C type of a type GIR does not describe, such as `GPid`, carried as a number. */
function isScalarCType(cType: string): boolean {
	return !!cType && !cType.includes('*') && !['void', 'gpointer', 'gconstpointer'].includes(cType);
}

/** The `Napi::Number` accessor that preserves a numeric GIR type's range. */
function numberAccessor(girType: string): string {
	if (girType.includes('double') || girType.includes('float')) return 'DoubleValue()';
	if (/64|size|ptr|offset|GType|long/.test(girType)) return 'Int64Value()';
	return 'Int32Value()';
}

/**
 * Emit parameter extraction, the C call (with error handling) and the JS return
 * for a function. `leading` is prepended to the call args (`self` for methods).
 */
function* callAndReturn(ctx: TypeContext, func: Func, leading: string[]): Lines {
	const cppParams: string[] = [];
	const outParams = yield* emitParams(ctx, func, leading, cppParams);

	const err = errorParam(func);
	if (err) yield `GError* ${err} = NULL;`;

	const rv = func.returnValue;
	let resultVar: string | null = null;
	if (rv.type.girType === 'none') {
		yield callExpr(`${func.cName}`, cppParams, err);
	} else {
		resultVar = 'result';
		yield callExpr(`auto ${resultVar} = ${func.cName}`, cppParams, err);
	}

	if (err) yield* errorCheck(err);
	yield* emitResult(ctx, func, resultVar, outParams);
}

/**
 * Convert a C value `varName` (of GIR type `type`, with `transfer` ownership)
 * into a `Napi::Value`, yielding an expression via `emit(expr)`. Shared by
 * function returns, property getters and array elements. Does not itself emit a
 * `return`; the caller decides what to do with the produced value.
 */
function* convertToJs(
	ctx: TypeContext,
	type: TypeRef,
	transfer: ReturnValue['transfer'],
	varName: string,
	emit: (valueExpr: string) => string
): Lines {
	const t = type.girType;

	if (type.isArray) {
		yield* convertArrayToJs(ctx, type, transfer, varName, emit);
		return;
	}
	if (t === 'utf8' || t === 'filename') {
		yield `Napi::String ${varName}_js = Napi::String::New(env, ${varName} ? (const char*)${varName} : "");`;
		if (transfer !== 'none') yield `g_free((gpointer)${varName});`;
		yield emit(`${varName}_js`);
		return;
	}
	if (t === 'gboolean') {
		yield emit(`Napi::Boolean::New(env, ${varName})`);
		return;
	}
	if (ctx.enumeration(t)) {
		yield emit(`Napi::Number::New(env, static_cast<int32_t>(${varName}))`);
		return;
	}
	if (ctx.isPrimitive(t) || t === 'GLib.Quark' || isScalarCType(type.cType)) {
		yield emit(`Napi::Number::New(env, static_cast<double>(${varName}))`);
		return;
	}
	if (t === 'GLib.Bytes') {
		yield* bytesToJs(varName, transfer, emit);
		return;
	}
	if (ctx.objectType(t)) {
		yield emit(`girbind::wrap_object(env, (gpointer)${varName}, ${transfer !== 'none'})`);
		return;
	}
	// Boxed or unknown type: hand back an opaque External, reffed when we own it so it outlives the JS handle.
	yield foreignToJs(ctx.cBaseType(type), varName, transfer, emit);
}

const foreignToJs = (base: string, varName: string, transfer: ReturnValue['transfer'], emit: (e: string) => string) =>
	`${emit(
		transfer !== 'none'
			? `Napi::External<${base}>::New(env, (${base}*)${varName}, [](Napi::Env, ${base}* p) { if (p && G_IS_OBJECT(p)) g_object_unref(p); })`
			: `Napi::External<${base}>::New(env, (${base}*)${varName})`
	)}`;

function* bytesToJs(varName: string, transfer: ReturnValue['transfer'], emit: (e: string) => string): Lines {
	yield `gsize ${varName}_len = 0;`;
	yield `gconstpointer ${varName}_data = g_bytes_get_data(${varName}, &${varName}_len);`;
	yield `Napi::Buffer<uint8_t> ${varName}_buf = Napi::Buffer<uint8_t>::Copy(env, static_cast<const uint8_t*>(${varName}_data), ${varName}_len);`;
	if (transfer !== 'none') yield `g_bytes_unref(${varName});`;
	yield emit(`${varName}_buf`);
}

/** Convert a C array (`char**` / `GPtrArray*`) to a JS array. */
function* convertArrayToJs(
	ctx: TypeContext,
	type: TypeRef,
	transfer: ReturnValue['transfer'],
	varName: string,
	emit: (e: string) => string
): Lines {
	const kind = ctx.arrayKind(type);

	if (kind === 'strv') {
		yield `Napi::Array ${varName}_js = Napi::Array::New(env);`;
		yield `if (${varName}) {`;
		yield `\tfor (gsize i = 0; ${varName}[i] != NULL; i++) {`;
		yield `\t\t${varName}_js.Set(static_cast<uint32_t>(i), Napi::String::New(env, ${varName}[i]));`;
		yield '\t}';
		if (transfer !== 'none') yield `\tg_strfreev(${varName});`;
		yield '}';
		yield emit(`${varName}_js`);
		return;
	}

	if (kind === 'ptrArray') {
		const elem = type.elementType ?? '';
		yield `Napi::Array ${varName}_js = Napi::Array::New(env);`;
		yield `if (${varName}) {`;
		yield `\tfor (guint i = 0; i < ${varName}->len; i++) {`;
		yield `\t\tgpointer ${varName}_item = g_ptr_array_index(${varName}, i);`;
		// Container transfer means elements are borrowed; element transfer none.
		if (ctx.objectType(elem)) {
			yield `\t\t${varName}_js.Set(i, girbind::wrap_object(env, ${varName}_item, false));`;
		} else {
			const base = ctx.cBaseType({ girType: elem, cType: '', isArray: false });
			yield `\t\t${foreignToJs(base, `${varName}_item`, 'none', v => `${varName}_js.Set(i, ${v});`)}`;
		}
		yield '\t}';
		if (transfer !== 'none') yield `\tg_ptr_array_unref(${varName});`;
		yield '}';
		yield emit(`${varName}_js`);
		return;
	}

	yield `// TODO: convert array return of element type "${type.elementType ?? '?'}"`;
	yield emit('env.Null()');
}

/** An output parameter whose value is collected into the function result. */
interface OutParam {
	name: string;
	/** Key of this value in a multi-value result object. */
	key: string;
	type: TypeRef;
}

/**
 * Declare `local` and fill it from the JS value `source` for an input
 * parameter, returning the expression to pass to C. Throws a TypeError (as a
 * C++ exception) on a type mismatch.
 */
function* fromJs(ctx: TypeContext, p: Parameter, source: string, local: string): Generator<string, string, void> {
	const t = p.type.girType;
	function* expect(check: string, expected: string): Lines {
		yield `if (!${source}.${check}) {`;
		yield `\tthrow Napi::TypeError::New(env, "Expected ${expected} for '${p.name}'");`;
		yield '}';
	}
	const absent = `${source}.IsNull() || ${source}.IsUndefined()`;

	// A string array may appear as an <array> or as utf8 with a `char**` c:type.
	const isStrvParam =
		(p.type.isArray && ctx.arrayKind(p.type) === 'strv')
		|| ((t === 'utf8' || t === 'filename') && /\*\s*\*/.test(p.type.cType));

	if (isStrvParam) {
		// JS string[] -> NULL-terminated char**. Backing storage lives for the
		// duration of the wrapper call, which is all the C call needs.
		yield* expect('IsArray()', 'string[]');
		yield `Napi::Array ${local}_arr = ${source}.As<Napi::Array>();`;
		yield `std::vector<std::string> ${local}_store;`;
		yield `std::vector<const char*> ${local}_vec;`;
		yield `for (uint32_t i = 0; i < ${local}_arr.Length(); i++) {`;
		yield `\t${local}_store.push_back(${local}_arr.Get(i).As<Napi::String>().Utf8Value());`;
		yield '}';
		yield `for (auto& s : ${local}_store) ${local}_vec.push_back(s.c_str());`;
		yield `${local}_vec.push_back(NULL);`;
		yield `const char** ${local} = ${local}_vec.data();`;
		return p.type.cType ? `(${p.type.cType})${local}` : local;
	}

	if (p.type.isArray) {
		yield `// TODO: array parameter "${p.name}" of element type "${p.type.elementType ?? '?'}"`;
		return 'NULL';
	}

	if (t === 'utf8' || t === 'filename') {
		yield `std::string ${local}_str;`;
		yield `const char* ${local} = NULL;`;
		if (p.nullable) {
			yield `if (!(${absent})) {`;
			yield* indent(...expect('IsString()', 'string'));
			yield `\t${local}_str = ${source}.As<Napi::String>().Utf8Value();`;
			yield `\t${local} = ${local}_str.c_str();`;
			yield '}';
		} else {
			yield* expect('IsString()', 'string');
			yield `${local}_str = ${source}.As<Napi::String>().Utf8Value();`;
			yield `${local} = ${local}_str.c_str();`;
		}
		return p.type.cType ? `(${p.type.cType})${local}` : local;
	}
	if (t === 'gboolean') {
		yield* expect('IsBoolean()', 'boolean');
		yield `gboolean ${local} = ${source}.As<Napi::Boolean>().Value();`;
		return local;
	}
	if (ctx.enumeration(t)) {
		const ct = ctx.cType(p.type).replace(/\*$/, '').trim();
		yield* expect('IsNumber()', 'number');
		yield `${ct} ${local} = static_cast<${ct}>(${source}.As<Napi::Number>().Int32Value());`;
		return local;
	}
	if (ctx.isPrimitive(t) || isScalarCType(p.type.cType)) {
		const ct = ctx.cType(p.type);
		yield* expect('IsNumber()', 'number');
		yield `${ct} ${local} = static_cast<${ct}>(${source}.As<Napi::Number>().${numberAccessor(t)});`;
		return local;
	}
	const object = ctx.objectType(t);
	if (object) {
		const base = ctx.cBaseType(p.type);
		yield `${base}* ${local} = girbind::unwrap_object<${base}>(${source}, ${ctx.gtypeExpression(object)}, "${object.qualified}", ${p.nullable});`;
		return local;
	}
	// Boxed or unknown type: accept an opaque External produced elsewhere.
	const base = ctx.cBaseType(p.type);
	yield `${base}* ${local} = NULL;`;
	if (p.nullable) {
		yield `if (!(${absent})) {`;
		yield* indent(...expect('IsExternal()', `external ${t}`));
		yield `\t${local} = ${source}.As<Napi::External<${base}>>().Data();`;
		yield '}';
	} else {
		yield* expect('IsExternal()', `external ${t}`);
		yield `${local} = ${source}.As<Napi::External<${base}>>().Data();`;
	}
	return local;
}

function* param(ctx: TypeContext, p: Parameter, index: number, cppParams: string[], outParams: OutParam[]): Lines {
	if (isErrorParam(p)) return;

	if (p.direction !== 'in') {
		// Allocate a local of the pointed-to type and pass its address. The C param
		// is `T*` (e.g. `gboolean*`, `FlatpakInstance**`), so the local is `T`:
		// strip exactly one pointer level from the c:type.
		const stripped = p.type.cType.replace(/\*\s*$/, '').trim() || ctx.cBaseType(p.type);
		const local = stripped === 'void' ? 'gpointer' : stripped;
		yield `${local} out_${p.name} = ${local.endsWith('*') || local === 'gpointer' ? 'NULL' : '{}'};`;
		cppParams.push(`&out_${p.name}`);
		outParams.push({ name: `out_${p.name}`, key: p.name, type: { ...p.type, cType: local } });
		return;
	}

	cppParams.push(yield* fromJs(ctx, p, `info[${index}]`, `arg_${p.name}`));
}

/**
 * Emit extraction for all of a function's parameters, returning the collected
 * output parameters (which the caller folds into the JS return). `leading` is
 * prepended to the C call args (e.g. `self` for instance methods).
 */
function* emitParams(
	ctx: TypeContext,
	func: Func,
	leading: string[],
	cppParams: string[]
): Generator<string, OutParam[], void> {
	const outParams: OutParam[] = [];
	cppParams.push(...leading);
	let jsIndex = 0;
	for (const p of func.parameters) {
		if (p.isInstance) continue;
		yield* param(ctx, p, jsIndex, cppParams, outParams);
		// Output params do not consume a JS argument slot.
		if (p.direction === 'in' && !isErrorParam(p)) jsIndex++;
	}
	return outParams;
}

/**
 * After the C call, produce the JS return from the real return value plus any
 * output parameters: a lone out-param (with void return) becomes the result; a
 * void return with no out-params yields `undefined`; multiple values become an
 * object keyed by parameter name.
 */
function* emitResult(ctx: TypeContext, func: Func, resultVar: string | null, outParams: OutParam[]): Lines {
	const hasReturn = resultVar !== null;

	if (!hasReturn && outParams.length === 0) {
		yield 'return env.Undefined();';
		return;
	}
	if (!hasReturn && outParams.length === 1) {
		const o = outParams[0];
		yield* convertToJs(ctx, o.type, func.returnValue.transfer, o.name, v => `return ${v};`);
		return;
	}
	if (hasReturn && outParams.length === 0) {
		yield* convertToJs(ctx, func.returnValue.type, func.returnValue.transfer, resultVar, v => `return ${v};`);
		return;
	}

	// Multiple values: bundle into an object. The real return (if any) is keyed
	// "return"; each out-param under its (stripped) name.
	yield 'Napi::Object js_result = Napi::Object::New(env);';
	if (hasReturn) {
		yield* convertToJs(
			ctx,
			func.returnValue.type,
			func.returnValue.transfer,
			resultVar,
			v => `js_result.Set("return", ${v});`
		);
	}
	for (const o of outParams) {
		yield* convertToJs(ctx, o.type, 'none', o.name, v => `js_result.Set("${o.key}", ${v});`);
	}
	yield 'return js_result;';
}

// --- module init ------------------------------------------------------------

/** `$init(internal)`: store the runtime ABI, then define and return every class and function. */
function* moduleInit(ctx: TypeContext, moduleName: string): Lines {
	yield 'Napi::Value module_init(const Napi::CallbackInfo& info) {';
	yield '\tNapi::Env env = info.Env();';
	yield '\tgirbind::init(info);';
	yield '\tNapi::Object exports = Napi::Object::New(env);';
	for (const cls of boundClasses(ctx)) {
		const parent = ctx.boundParent(cls);
		const parentExpression =
			parent.source === 'local'
				? `class_${shortName(parent.qualified)}`
				: `girbind::lookup(env, "${parent.typeName}")`;
		yield `\tNapi::Function class_${cls.name} = define_${cls.name}(env, ${parentExpression});`;
		yield `\texports.Set("${cls.name}", class_${cls.name});`;
	}
	for (const { func, jsName } of functionExportNames(ctx.ns)) {
		yield `\texports.Set("${jsName}", Napi::Function::New(env, Wrap_${func.cName}, "${jsName}"));`;
	}
	yield '\treturn exports;';
	yield '}';
	yield '';
	yield 'Napi::Object Init(Napi::Env env, Napi::Object exports) {';
	yield '\texports.Set("$init", Napi::Function::New(env, module_init, "$init"));';
	yield '\treturn exports;';
	yield '}';
	yield '';
	yield '} // namespace';
	yield '';
	// cmake-js (unlike node-gyp) does not define NODE_GYP_MODULE_NAME, so the
	// module is registered under an explicit name that must match the built
	// `<name>.node` and the require() path in the generated entry point.
	yield `NODE_API_MODULE(${moduleName}, Init)`;
}

export interface Options {
	/**
	 * Registered module name; must match the built `<name>.node` and the
	 * require() path in the generated JS. Defaults to the namespace name,
	 * lowercased.
	 */
	moduleName?: string;
	/**
	 * Additional `#include` directives (the library's own header), e.g.
	 * `['<flatpak/flatpak.h>']`. Bare names without `<>`/`""` are wrapped in `<>`.
	 */
	includes?: string[];
	/** Preprocessor macros to define before the includes. */
	defines?: string[];
	/** The namespace and the namespaces it includes, for resolving types from other namespaces. */
	repository?: Repository;
	/** Import specifiers of other bound namespaces, by namespace name. */
	modules?: Record<string, string>;
}

/** Always-needed includes; the target library's header is added via options. */
const BASE_INCLUDES = ['<girbind.hxx>', '<memory>', '<string>', '<vector>'];

function includeDirective(inc: string): string {
	const wrapped = inc.startsWith('<') || inc.startsWith('"') ? inc : `<${inc}>`;
	return `#include ${wrapped}`;
}

function* file(ns: Namespace, options: Options): Lines {
	const ctx = new TypeContext(ns, options.repository, options.modules);
	const moduleName = options.moduleName ?? ns.name.toLowerCase();

	yield `// Generated by girbind from ${ns.name}-${ns.version}`;
	yield '// DO NOT EDIT THIS FILE DIRECTLY';
	yield '';
	for (const define of options.defines ?? []) yield `#define ${define}`;
	for (const inc of [...BASE_INCLUDES, ...(options.includes ?? [])]) yield includeDirective(inc);
	yield '';
	yield 'namespace {';
	yield '';

	for (const cls of boundClasses(ctx)) yield* classDef(ctx, cls);
	for (const func of ns.functions.filter(isSupported)) yield* standalone(ctx, func);
	yield* moduleInit(ctx, moduleName);
}

export function generate(ns: Namespace, options: Options = {}): string {
	return [...file(ns, options)].join('\n') + '\n';
}
