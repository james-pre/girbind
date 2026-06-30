/**
 * C++ N-API addon emitter.
 *
 * C++ classes are **flattened** (not C++-inherited): each is its own
 * `Napi::ObjectWrap<T>` with its own `handle_`, because N-API's CRTP base does
 * not compose with C++ inheritance (a child would shadow the parent's `handle_`
 * and break `Unwrap<T>` identity). Inherited methods/accessors are therefore
 * re-emitted on each leaf, casting `self` to the type of the class that *owns*
 * the underlying C function (a GObject is-a its parent, so the upcast is valid).
 *
 * Inheritance is still observable where it matters: the JS prototype chain is
 * linked in the generated entry point (see {@link ./js}) so `child instanceof
 * Parent` holds, and the TS emitter uses real `extends`.
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
import { TypeContext } from '../types.js';

/** Statement emitted to bail out of parameter extraction on a type error. */
type FailReturn = 'return env.Null();' | 'return;';

/** A member resolved through the hierarchy, tagged with its owning class. */
interface Owned<T> {
	owner: Class;
	member: T;
}

/** Shared emitter state threaded through the generator functions. */
interface Cxx {
	ctx: TypeContext;
	/** Bail-out statement for the body currently being emitted. */
	failReturn: FailReturn;
}

type Lines = Generator<string, void, void>;

/** Indent a block of already-rendered lines by one tab. */
function* indent(...lines: string[]): Lines {
	for (const line of lines) yield line === '' ? '' : '\t' + line;
}

// --- hierarchy helpers ------------------------------------------------------

/** Walk the parent chain (within our classes), nearest first. */
function hierarchy(ctx: TypeContext, cls: Class): Class[] {
	const chain: Class[] = [];
	let current: Class | undefined = cls;
	while (current) {
		chain.push(current);
		current = current.parent ? ctx.classes.get(current.parent) : undefined;
	}
	return chain;
}

/** Inherited members of a kind, child-overrides-parent, tagged with their owner. */
function collect<T>(ctx: TypeContext, cls: Class, pick: (c: Class) => T[], key: (m: T) => string): Owned<T>[] {
	const seen = new Set<string>();
	const out: Owned<T>[] = [];
	for (const owner of hierarchy(ctx, cls)) {
		for (const member of pick(owner)) {
			const k = key(member);
			if (seen.has(k)) continue;
			seen.add(k);
			out.push({ owner, member });
		}
	}
	return out;
}

const methods = (ctx: TypeContext, cls: Class) => collect(ctx, cls, c => c.methods.filter(isSupported), methodName);
const statics = (ctx: TypeContext, cls: Class) =>
	collect(ctx, cls, c => c.staticMethods.filter(isSupported), methodName);
const properties = (ctx: TypeContext, cls: Class) => {
	// A property whose camelCase name collides with a method (or static) is
	// dropped: the method already exposes it, and registering both would be a
	// duplicate key at runtime (and a duplicate identifier in the .d.ts).
	const taken = new Set([...methods(ctx, cls), ...statics(ctx, cls)].map(m => methodName(m.member)));
	return collect(
		ctx,
		cls,
		c => c.properties,
		p => p.name
	).filter(({ member }) => !taken.has(propJsName(member)));
};

function propId(p: Property): string {
	return p.name.replace(/-/g, '_');
}

/** Whether a getter accessor is emitted for a property (always, if readable). */
function hasGetter(p: Property): boolean {
	return p.readable;
}

/**
 * Whether a setter accessor is emitted. We emit one when the property is
 * writable and either has a backing setter method or is not construct-only
 * (construct-only props with no setter method get no runtime setter).
 */
function hasSetter(cxx: Cxx, owner: Class, p: Property): boolean {
	if (!p.writable) return false;
	if (accessorMethod(cxx, owner, p.setter)) return true;
	return !p.constructOnly;
}

function propJsName(p: Property): string {
	return p.name.replace(/-/g, '_').replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function errorParam(func: Func): string | undefined {
	if (func.parameters.some(p => p.name === 'error')) return 'error';
	return func.throws ? 'error' : undefined;
}

/**
 * The `self` local for a (possibly inherited) member. When inherited, the C
 * function expects the owner's type, so upcast the leaf handle
 * (`reinterpret_cast` — a real GObject is-a relationship).
 */
function selfLocal(cls: Class, owner: Class): string {
	return owner === cls
		? `${cls.cName}* self = this->self(env);`
		: `${owner.cName}* self = reinterpret_cast<${owner.cName}*>(this->self(env));`;
}

// --- declarations -----------------------------------------------------------

function* classDecl(cxx: Cxx, cls: Class): Lines {
	const { ctx } = cxx;
	yield `class ${cls.name} : public Napi::ObjectWrap<${cls.name}> {
public:
	static Napi::FunctionReference constructor;
	static void Init(Napi::Env env, Napi::Object& exports);
	static Napi::Object NewInstance(Napi::Env env, ${cls.cName}* handle);
	${cls.name}(const Napi::CallbackInfo& info);
	~${cls.name}() override;
	${cls.cName}* handle_ = nullptr;

protected:
	static bool constructing;
	${cls.cName}* self(Napi::Env env);
`;

	for (const f of secondaryConstructors(cls.constructors).filter(isSupported))
		yield `	static Napi::Value ${f.name}_factory(const Napi::CallbackInfo& info);`;

	for (const { member } of statics(ctx, cls))
		yield `	static Napi::Value ${methodName(member)}(const Napi::CallbackInfo& info);`;
	for (const { member } of methods(ctx, cls))
		yield `	Napi::Value ${methodName(member)}(const Napi::CallbackInfo& info);`;

	for (const { owner, member } of properties(ctx, cls)) {
		if (hasGetter(member)) yield `\tNapi::Value prop_get_${propId(member)}(const Napi::CallbackInfo& info);`;
		if (hasSetter(cxx, owner, member))
			yield `\tvoid prop_set_${propId(member)}(const Napi::CallbackInfo& info, const Napi::Value& value);`;
	}

	yield '};';
	yield '';
}

// --- definitions ------------------------------------------------------------

function* classDef(cxx: Cxx, cls: Class): Lines {
	const { ctx } = cxx;
	yield `Napi::FunctionReference ${cls.name}::constructor;`;
	yield `bool ${cls.name}::constructing = false;`;
	yield '';
	yield* initMethod(cxx, cls);
	yield newInstance(cls);
	yield* constructor(cxx, cls);
	yield `${cls.name}::~${cls.name}() {
	if (handle_ && G_IS_OBJECT(handle_)) {
		g_object_unref(handle_);
	}
	handle_ = nullptr;
}
`;
	yield `${cls.cName}* ${cls.name}::self(Napi::Env env) {
	if (!handle_) {
		Napi::Error::New(env, "${cls.name} has not been initialized").ThrowAsJavaScriptException();
	}
	return handle_;
}
`;
	for (const f of secondaryConstructors(cls.constructors).filter(isSupported)) yield* factory(cxx, cls, f);
	for (const { member } of statics(ctx, cls)) yield* staticMethod(cxx, cls, member);
	for (const { owner, member } of methods(ctx, cls)) yield* method(cxx, cls, owner, member);
	for (const { owner, member } of properties(ctx, cls)) yield* accessors(cxx, cls, owner, member);
}

function* initMethod(cxx: Cxx, cls: Class): Lines {
	const { ctx } = cxx;
	yield `void ${cls.name}::Init(Napi::Env env, Napi::Object& exports) {`;
	yield `\tNapi::Function func = DefineClass(env, "${cls.name}", {`;

	const entries: string[] = [];
	for (const { member } of methods(ctx, cls)) {
		entries.push(`\t\tInstanceMethod("${methodName(member)}", &${cls.name}::${methodName(member)})`);
	}
	for (const { owner, member } of properties(ctx, cls)) {
		const g = hasGetter(member) ? `&${cls.name}::prop_get_${propId(member)}` : 'nullptr';
		const s = hasSetter(cxx, owner, member) ? `&${cls.name}::prop_set_${propId(member)}` : 'nullptr';
		if (g === 'nullptr' && s === 'nullptr') continue;
		entries.push(`\t\tInstanceAccessor("${propJsName(member)}", ${g}, ${s})`);
	}
	for (const f of secondaryConstructors(cls.constructors).filter(isSupported)) {
		entries.push(`\t\tStaticMethod("${factoryName(f)}", &${cls.name}::${f.name}_factory)`);
	}
	for (const { member } of statics(ctx, cls)) {
		entries.push(`\t\tStaticMethod("${methodName(member)}", &${cls.name}::${methodName(member)})`);
	}
	yield entries.join(',\n');

	yield '	});';
	yield `
	constructor = Napi::Persistent(func);
	constructor.SuppressDestruct();
	exports.Set("${cls.name}", func);
}
`;
}

const newInstance = (cls: Class): string =>
	`Napi::Object ${cls.name}::NewInstance(Napi::Env env, ${cls.cName}* handle) {
	Napi::EscapableHandleScope scope(env);
	constructing = true;
	Napi::Object obj;
	try {
		obj = constructor.New({});
	} catch (...) {
		constructing = false;
		throw;
	}
	constructing = false;
	
	${cls.name}* wrapper = ${cls.name}::Unwrap(obj);
	if (handle && G_IS_OBJECT(handle)) {
		g_object_ref(handle);
	}
	wrapper->handle_ = handle;
	return scope.Escape(obj).As<Napi::Object>();
}
`;

function* constructor(cxx: Cxx, cls: Class): Lines {
	yield `${cls.name}::${cls.name}(const Napi::CallbackInfo& info)
	: Napi::ObjectWrap<${cls.name}>(info) {
	Napi::Env env = info.Env();
	if (constructing) {
		return;
	}
`;

	const candidate = primaryConstructor(cls.constructors);
	// A constructor taking a callback can't be wrapped yet; treat the class as
	// non-constructable rather than emit a broken `new`.
	const primary = candidate && isSupported(candidate) ? candidate : undefined;
	if (!primary) {
		yield `	Napi::TypeError::New(env, "${cls.name} objects cannot be constructed directly").ThrowAsJavaScriptException();
	return;
}
`;
		return;
	}

	cxx.failReturn = 'return;';
	const cppParams: string[] = [];
	yield* indent(...emitParams(cxx, primary, [], cppParams));
	cxx.failReturn = 'return env.Null();';

	const err = errorParam(primary);
	if (err) yield `\tGError* ${err} = NULL;`;
	yield `\t${callExpr(`${cls.cName}* handle = ${primary.cName}`, cppParams, err)}`;
	yield '';
	if (err) yield* indent(...errorCheck(err, 'return;'));
	yield '\thandle_ = handle;';
	yield '}';
	yield '';
}

function* method(cxx: Cxx, cls: Class, owner: Class, func: Func): Lines {
	yield `Napi::Value ${cls.name}::${methodName(func)}(const Napi::CallbackInfo& info) {
	Napi::Env env = info.Env();
	${selfLocal(cls, owner)}
	if (!self) {
		return env.Null();
	}
`;
	yield* indent(...callAndReturn(cxx, func, ['self']));
	yield '}';
	yield '';
}

function* staticMethod(cxx: Cxx, cls: Class, func: Func): Lines {
	yield `Napi::Value ${cls.name}::${methodName(func)}(const Napi::CallbackInfo& info) {`;
	yield '\tNapi::Env env = info.Env();';
	yield '';
	yield* indent(...callAndReturn(cxx, func, []));
	yield '}';
	yield '';
}

function* factory(cxx: Cxx, cls: Class, func: Func): Lines {
	yield `Napi::Value ${cls.name}::${func.name}_factory(const Napi::CallbackInfo& info) {`;
	yield '\tNapi::Env env = info.Env();';
	yield '';
	const cppParams: string[] = [];
	yield* indent(...emitParams(cxx, func, [], cppParams));
	const err = errorParam(func);
	if (err) yield `\tGError* ${err} = NULL;`;
	yield `\t${callExpr(`${cls.cName}* handle = ${func.cName}`, cppParams, err)}`;
	yield '';
	if (err) yield* indent(...errorCheck(err, 'return env.Null();'));
	yield '\tif (!handle) {';
	yield '\t\treturn env.Null();';
	yield '\t}';
	yield `\tNapi::Object obj = ${cls.name}::NewInstance(env, handle);`;
	yield '\tif (G_IS_OBJECT(handle)) {';
	yield '\t\tg_object_unref(handle);';
	yield '\t}';
	yield '\treturn obj;';
	yield '}';
	yield '';
}

function* standalone(cxx: Cxx, func: Func): Lines {
	yield `Napi::Value Wrap_${func.cName}(const Napi::CallbackInfo& info) {`;
	yield '\tNapi::Env env = info.Env();';
	yield '';
	yield* indent(...callAndReturn(cxx, func, []));
	yield '}';
	yield '';
}

/** Find the instance method implementing a property accessor, searching the hierarchy from `owner`. */
function accessorMethod(
	cxx: Cxx,
	owner: Class,
	methodGirName: string | undefined
): { fn: Func; on: Class } | undefined {
	if (!methodGirName) return undefined;
	for (const c of hierarchy(cxx.ctx, owner)) {
		const fn = c.methods.find(m => m.name === methodGirName);
		if (fn) return { fn, on: c };
	}
	return undefined;
}

function* accessors(cxx: Cxx, cls: Class, owner: Class, p: Property): Lines {
	const getter = accessorMethod(cxx, owner, p.getter);
	const setter = accessorMethod(cxx, owner, p.setter);

	if (p.readable && getter) {
		yield `Napi::Value ${cls.name}::prop_get_${propId(p)}(const Napi::CallbackInfo& info) {`;
		yield '\tNapi::Env env = info.Env();';
		yield `\t${selfLocal(cls, getter.on)}`;
		yield '\tif (!self) {';
		yield '\t\treturn env.Null();';
		yield '\t}';
		// The getter is a zero-arg method on `self`; call it directly and convert.
		const err = errorParam(getter.fn);
		if (err) yield `\tGError* ${err} = NULL;`;
		yield `\t${callExpr(`${cxx.ctx.cType(getter.fn.returnValue.type)} value = ${getter.fn.cName}`, ['self'], err)}`;
		if (err) yield* indent(...errorCheck(err, 'return env.Null();'));
		yield* indent(
			...convertToJs(
				cxx.ctx,
				getter.fn.returnValue.type,
				getter.fn.returnValue.transfer,
				'value',
				v => `return ${v};`
			)
		);
		yield '}';
		yield '';
	} else if (p.readable) {
		// No getter method: a generic GValue read is the fallback, not yet emitted.
		yield `Napi::Value ${cls.name}::prop_get_${propId(p)}(const Napi::CallbackInfo& info) {`;
		yield '\tNapi::Env env = info.Env();';
		yield `\t${selfLocal(cls, owner)}`;
		yield '\t(void)self;';
		yield `\t// TODO: read property "${p.name}" via g_object_get (no getter method in GIR)`;
		yield '\treturn env.Null();';
		yield '}';
		yield '';
	}

	if (p.writable && setter) {
		const valueParam = setter.fn.parameters.find(sp => !sp.isInstance && sp.name !== 'error');
		yield `void ${cls.name}::prop_set_${propId(p)}(const Napi::CallbackInfo& info, const Napi::Value& value) {`;
		yield '\tNapi::Env env = info.Env();';
		yield `\t${selfLocal(cls, setter.on)}`;
		yield '\tif (!self) {';
		yield '\t\treturn;';
		yield '\t}';
		if (valueParam) {
			cxx.failReturn = 'return;';
			yield* indent(...setterValue(cxx, valueParam));
			cxx.failReturn = 'return env.Null();';
			const err = errorParam(setter.fn);
			if (err) yield `\tGError* ${err} = NULL;`;
			yield `\t${callExpr(`${setter.fn.cName}`, ['self', valueParam.name], err)}`;
			if (err) yield* indent(...errorCheck(err, 'return;'));
		}
		yield '}';
		yield '';
	} else if (p.writable && !p.constructOnly) {
		yield `void ${cls.name}::prop_set_${propId(p)}(const Napi::CallbackInfo& info, const Napi::Value& value) {`;
		yield '\tNapi::Env env = info.Env();';
		yield `\t${selfLocal(cls, owner)}`;
		yield '\t(void)self;';
		yield '\t(void)value;';
		yield `\t// TODO: write property "${p.name}" via g_object_set (no setter method in GIR)`;
		yield '}';
		yield '';
	}
}

/** Extract a property setter's single value from `value` (not `info[i]`). */
function* setterValue(cxx: Cxx, p: Parameter): Lines {
	const { ctx } = cxx;
	const t = p.type.girType;
	if (t === 'utf8' || t === 'filename') {
		yield `std::string ${p.name}_str = value.As<Napi::String>().Utf8Value();`;
		yield `const char* ${p.name} = ${p.name}_str.c_str();`;
		return;
	}
	if (t === 'gboolean') {
		yield `gboolean ${p.name} = value.As<Napi::Boolean>().Value();`;
		return;
	}
	if (ctx.enumeration(t)) {
		const ct = ctx.cType(p.type).replace(/\*$/, '').trim();
		yield `${ct} ${p.name} = static_cast<${ct}>(value.As<Napi::Number>().Int32Value());`;
		return;
	}
	if (ctx.isPrimitive(t)) {
		const ct = ctx.cType(p.type);
		const accessor = t.includes('64')
			? 'Int64Value()'
			: t.includes('double') || t.includes('float')
				? 'DoubleValue()'
				: 'Int32Value()';
		yield `${ct} ${p.name} = value.As<Napi::Number>().${accessor};`;
		return;
	}
	const cls = ctx.ourClass(t);
	if (cls) {
		yield `${ctx.cType(p.type)} ${p.name} = ${cls.name}::Unwrap(value.As<Napi::Object>())->handle_;`;
		return;
	}
	yield `// TODO: setter value of type "${t}"`;
	yield `${ctx.cBaseType(p.type)}* ${p.name} = NULL;`;
}

// --- call + conversion ------------------------------------------------------

/** Build a C call expression: `<lhs>(<params>[, &error]);`. */
function callExpr(lhs: string, cppParams: string[], err: string | undefined): string {
	let call = `${lhs}(${cppParams.join(', ')}`;
	if (err) call += (cppParams.length ? ', &' : '&') + err;
	return call + ');';
}

/** Lines that throw and bail when `err` is set after a C call. */
function* errorCheck(err: string, onError: string): Lines {
	yield `if (${err}) {`;
	yield `\tNapi::Error::New(env, ${err}->message).ThrowAsJavaScriptException();`;
	yield `\tg_error_free(${err});`;
	yield `\t${onError}`;
	yield '}';
}

/**
 * Emit parameter extraction, the C call (with error handling) and the JS return
 * for a function. `leading` is prepended to the call args (`self` for methods).
 */
function* callAndReturn(cxx: Cxx, func: Func, leading: string[]): Lines {
	const cppParams: string[] = [];
	const outParams = yield* emitParams(cxx, func, leading, cppParams);

	const err = errorParam(func);
	if (err) yield `GError* ${err} = NULL;`;

	const rv = func.returnValue;
	let resultVar: string | null = null;
	if (rv.type.girType === 'none') {
		yield callExpr(`${func.cName}`, cppParams, err);
	} else {
		resultVar = 'result';
		yield callExpr(`${cxx.ctx.cType(rv.type)} ${resultVar} = ${func.cName}`, cppParams, err);
	}
	yield '';

	if (err) {
		yield* errorCheck(err, 'return env.Null();');
		yield '';
	}
	yield* emitResult(cxx, func, resultVar, outParams);
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
		yield `Napi::String ${varName}_js = Napi::String::New(env, ${varName} ? ${varName} : "");`;
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
	if (ctx.isPrimitive(t) || t === 'GLib.Quark') {
		yield emit(`Napi::Number::New(env, ${varName})`);
		return;
	}
	if (t === 'GLib.Bytes') {
		yield* bytesToJs(varName, transfer, emit);
		return;
	}
	const cls = ctx.ourClass(t);
	if (cls) {
		yield* ourClassToJs(cls.name, varName, transfer, emit);
		return;
	}
	// Foreign GObject / boxed type: hand back an opaque External, reffed when we
	// own it so it outlives the JS handle.
	yield foreignToJs(ctx.cBaseType(type), varName, transfer, emit);
}

/** `our class` pointer → wrapped ObjectWrap instance (or null). */
function* ourClassToJs(
	className: string,
	varName: string,
	transfer: ReturnValue['transfer'],
	emit: (e: string) => string
): Lines {
	yield `if (!${varName}) {`;
	yield `\t${emit('env.Null()')}`;
	yield '} else {';
	yield `\tNapi::Object ${varName}_js = ${className}::NewInstance(env, ${varName});`;
	if (transfer !== 'none') {
		// NewInstance took its own ref; drop the one we owned.
		yield `\tif (G_IS_OBJECT(${varName})) {`;
		yield `\t\tg_object_unref(${varName});`;
		yield '\t}';
	}
	yield `\t${emit(`${varName}_js`)}`;
	yield '}';
}

const foreignToJs = (base: string, varName: string, transfer: ReturnValue['transfer'], emit: (e: string) => string) =>
	`${emit(
		transfer !== 'none'
			? `Napi::External<${base}>::New(env, ${varName}, [](Napi::Env, ${base}* p) { if (p && G_IS_OBJECT(p)) g_object_unref(p); })`
			: `Napi::External<${base}>::New(env, ${varName})`
	)}`;

function* bytesToJs(varName: string, transfer: ReturnValue['transfer'], emit: (e: string) => string): Lines {
	yield `gsize ${varName}_len = 0;`;
	yield `gconstpointer ${varName}_data = g_bytes_get_data(${varName}, &${varName}_len);`;
	yield `Napi::Buffer<uint8_t> ${varName}_buf = Napi::Buffer<uint8_t>::Copy(env, static_cast<const uint8_t*>(${varName}_data), ${varName}_len);`;
	if (transfer !== 'none') yield `g_bytes_unref(${varName});`;
	yield emit(`${varName}_buf`);
}

/** Convert a C array (`char**` / `GPtrArray*` / known-element C array) to a JS array. */
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
		const elemCls = ctx.ourClass(elem);
		const elemType: TypeRef = { girType: elem, cType: '', isArray: false };
		yield `Napi::Array ${varName}_js = Napi::Array::New(env);`;
		yield `if (${varName}) {`;
		yield `\tfor (guint i = 0; i < ${varName}->len; i++) {`;
		yield `\t\tgpointer ${varName}_item = g_ptr_array_index(${varName}, i);`;
		// Container transfer means elements are borrowed; element transfer none.
		if (elemCls) {
			yield `\t\t${elemCls.cName}* ${varName}_typed = static_cast<${elemCls.cName}*>(${varName}_item);`;
			yield* indent(
				...indent(...ourClassToJs(elemCls.name, `${varName}_typed`, 'none', v => `${varName}_js.Set(i, ${v});`))
			);
		} else {
			const base = ctx.cBaseType(elemType);
			yield `\t\t${base}* ${varName}_typed = static_cast<${base}*>(${varName}_item);`;
			yield `\t\t${foreignToJs(base, `${varName}_typed`, 'none', v => `${varName}_js.Set(i, ${v});`)}`;
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
	type: TypeRef;
}

function* param(cxx: Cxx, p: Parameter, index: number, cppParams: string[], outParams: OutParam[]): Lines {
	const { ctx, failReturn } = cxx;
	if (p.name === 'error') return; // GError** handled separately

	if (p.direction !== 'in') {
		// Allocate a local of the pointed-to type and pass its address. The C param
		// is `T*` (e.g. `gboolean*`, `FlatpakInstance**`), so the local is `T`:
		// strip exactly one pointer level from the c:type.
		const local = p.type.cType.replace(/\*\s*$/, '').trim() || ctx.cBaseType(p.type);
		yield `${local} ${p.name}_out = ${local.endsWith('*') ? 'NULL' : '{}'};`;
		cppParams.push(`&${p.name}_out`);
		// For conversion, the produced value has the pointed-to type.
		outParams.push({ name: `${p.name}_out`, type: { ...p.type, cType: local } });
		return;
	}

	const t = p.type.girType;
	function* expect(check: string, expected: string): Lines {
		yield `if (info.Length() <= ${index} || !info[${index}].${check}) {`;
		yield `\tNapi::TypeError::New(env, "Expected ${expected} for '${p.name}'").ThrowAsJavaScriptException();`;
		yield `\t${failReturn}`;
		yield '}';
	}

	// A string array may appear as an <array> or as utf8 with a `char**` c:type.
	const isStrvParam =
		(p.type.isArray && ctx.arrayKind(p.type) === 'strv')
		|| ((t === 'utf8' || t === 'filename') && /\*\s*\*/.test(p.type.cType));

	if (isStrvParam) {
		// JS string[] -> NULL-terminated char**. Backing storage lives for the
		// duration of the wrapper call, which is all the C call needs.
		yield* expect('IsArray()', 'string[]');
		yield `Napi::Array ${p.name}_arr = info[${index}].As<Napi::Array>();`;
		yield `std::vector<std::string> ${p.name}_store;`;
		yield `std::vector<const char*> ${p.name}_vec;`;
		yield `for (uint32_t i = 0; i < ${p.name}_arr.Length(); i++) {`;
		yield `\t${p.name}_store.push_back(${p.name}_arr.Get(i).As<Napi::String>().Utf8Value());`;
		yield '}';
		yield `for (auto& s : ${p.name}_store) ${p.name}_vec.push_back(s.c_str());`;
		yield `${p.name}_vec.push_back(NULL);`;
		yield `const char** ${p.name} = ${p.name}_vec.data();`;
		cppParams.push(p.name);
		return;
	}

	if (p.type.isArray) {
		// Non-string array element types aren't converted yet; pass NULL so the
		// call stays valid and the gap is visible.
		yield `// TODO: array parameter "${p.name}" of element type "${p.type.elementType ?? '?'}"`;
		cppParams.push('NULL');
		return;
	}

	// True when the JS argument is absent or explicitly null/undefined.
	const absent = `info.Length() <= ${index} || info[${index}].IsNull() || info[${index}].IsUndefined()`;

	if (t === 'utf8' || t === 'filename') {
		if (p.nullable) {
			yield `std::string ${p.name}_str;`;
			yield `const char* ${p.name} = NULL;`;
			yield `if (!(${absent})) {`;
			yield* indent(...expect('IsString()', 'string'));
			yield `\t${p.name}_str = info[${index}].As<Napi::String>().Utf8Value();`;
			yield `\t${p.name} = ${p.name}_str.c_str();`;
			yield '}';
			cppParams.push(p.name);
			return;
		}
		yield* expect('IsString()', 'string');
		yield `std::string ${p.name}_str = info[${index}].As<Napi::String>().Utf8Value();`;
		yield `const char* ${p.name} = ${p.name}_str.c_str();`;
		cppParams.push(p.name);
		return;
	}
	if (t === 'gboolean') {
		yield* expect('IsBoolean()', 'boolean');
		yield `gboolean ${p.name} = info[${index}].As<Napi::Boolean>().Value();`;
		cppParams.push(p.name);
		return;
	}
	if (ctx.enumeration(t)) {
		const ct = ctx.cType(p.type).replace(/\*$/, '').trim();
		yield* expect('IsNumber()', 'number');
		yield `${ct} ${p.name} = static_cast<${ct}>(info[${index}].As<Napi::Number>().Int32Value());`;
		cppParams.push(p.name);
		return;
	}
	if (ctx.isPrimitive(t)) {
		const ct = ctx.cType(p.type);
		const accessor = t.includes('64')
			? 'Int64Value()'
			: t.includes('double') || t.includes('float')
				? 'DoubleValue()'
				: 'Int32Value()';
		yield* expect('IsNumber()', 'number');
		yield `${ct} ${p.name} = info[${index}].As<Napi::Number>().${accessor};`;
		cppParams.push(p.name);
		return;
	}
	const cls = ctx.ourClass(t);
	if (cls) {
		const ct = ctx.cType(p.type);
		if (p.nullable) {
			yield `${ct} ${p.name} = NULL;`;
			yield `if (!(${absent})) {`;
			yield* indent(...expect('IsObject()', cls.name));
			yield `\t${p.name} = ${cls.name}::Unwrap(info[${index}].As<Napi::Object>())->handle_;`;
			yield '}';
		} else {
			yield* expect('IsObject()', cls.name);
			yield `${ct} ${p.name} = ${cls.name}::Unwrap(info[${index}].As<Napi::Object>())->handle_;`;
		}
		cppParams.push(p.name);
		return;
	}
	// Foreign GObject / boxed type: accept an opaque External produced elsewhere.
	const base = ctx.cBaseType(p.type);
	if (p.nullable) {
		yield `${base}* ${p.name} = NULL;`;
		yield `if (!(${absent})) {`;
		yield* indent(...expect('IsExternal()', `external ${t}`));
		yield `\t${p.name} = info[${index}].As<Napi::External<${base}>>().Data();`;
		yield '}';
	} else {
		yield* expect('IsExternal()', `external ${t}`);
		yield `${base}* ${p.name} = info[${index}].As<Napi::External<${base}>>().Data();`;
	}
	cppParams.push(p.name);
}

/**
 * Emit extraction for all of a function's parameters, returning the collected
 * output parameters (which the caller folds into the JS return). `leading` is
 * prepended to the C call args (e.g. `self` for instance methods).
 */
function* emitParams(
	cxx: Cxx,
	func: Func,
	leading: string[],
	cppParams: string[]
): Generator<string, OutParam[], void> {
	const outParams: OutParam[] = [];
	cppParams.push(...leading);
	let jsIndex = 0;
	for (const p of func.parameters) {
		if (p.isInstance) continue;
		yield* indent(...param(cxx, p, jsIndex, cppParams, outParams));
		// Output params do not consume a JS argument slot.
		if (p.direction === 'in' && p.name !== 'error') jsIndex++;
	}
	return outParams;
}

/**
 * After the C call, produce the JS return from the real return value plus any
 * output parameters: a lone out-param (with void return) becomes the result; a
 * void return with no out-params yields `undefined`; multiple values become an
 * object keyed by parameter name.
 */
function* emitResult(cxx: Cxx, func: Func, resultVar: string | null, outParams: OutParam[]): Lines {
	const { ctx } = cxx;
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
		const key = o.name.replace(/_out$/, '');
		yield* convertToJs(ctx, o.type, 'none', o.name, v => `js_result.Set("${key}", ${v});`);
	}
	yield 'return js_result;';
}

// --- module init ------------------------------------------------------------

function* moduleInit(ns: Namespace, moduleName: string): Lines {
	yield 'Napi::Object Init(Napi::Env env, Napi::Object exports) {';
	for (const { func, jsName } of functionExportNames(ns)) {
		yield `\texports.Set("${jsName}", Napi::Function::New(env, Wrap_${func.cName}));`;
	}
	for (const cls of ns.classes) yield `\t${cls.name}::Init(env, exports);`;
	yield '\treturn exports;';
	yield '}';
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
}

/** Always-needed includes; the target library's header is added via options. */
const BASE_INCLUDES = ['<napi.h>', '<glib-object.h>', '<memory>', '<string>', '<vector>'];

function includeDirective(inc: string): string {
	const wrapped = inc.startsWith('<') || inc.startsWith('"') ? inc : `<${inc}>`;
	return `#include ${wrapped}`;
}

function* file(ns: Namespace, options: Options): Lines {
	const cxx: Cxx = { ctx: new TypeContext(ns), failReturn: 'return env.Null();' };
	const moduleName = options.moduleName ?? ns.name.toLowerCase();

	yield `// Generated by girbind from ${ns.name}-${ns.version}`;
	yield '// DO NOT EDIT THIS FILE DIRECTLY';
	yield '';
	for (const inc of [...BASE_INCLUDES, ...(options.includes ?? [])]) yield includeDirective(inc);
	yield '';

	for (const cls of ns.classes) yield* classDecl(cxx, cls);
	yield '';
	const standaloneFns = ns.functions.filter(isSupported);
	for (const func of standaloneFns) yield `Napi::Value Wrap_${func.cName}(const Napi::CallbackInfo& info);`;
	yield '';
	for (const cls of ns.classes) yield* classDef(cxx, cls);
	for (const func of standaloneFns) yield* standalone(cxx, func);
	yield* moduleInit(ns, moduleName);
}

export function generate(ns: Namespace, options: Options = {}): string {
	return [...file(ns, options)].join('\n') + '\n';
}
