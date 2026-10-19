import ts from "typescript-legacy";

import type { BunApiInventory } from "./bun-api-inventory.ts";
import { expressionPath, isGuarded } from "./release-inventory-guards.ts";
import type { GuardedAccess } from "./release-inventory-guards.ts";
import { isNodeRequireCall } from "./release-inventory-require.ts";
import type { RequireBindings } from "./release-inventory-require.ts";
import { ScopedBindings } from "./release-inventory-scope.ts";
import type {
  BuiltinDynamicMember,
  BuiltinMemberUse,
  ScannableModule,
} from "./release-inventory-types.ts";

export { expressionPath, isGuarded } from "./release-inventory-guards.ts";
export type { GuardedAccess } from "./release-inventory-guards.ts";

export interface BindingOrigin {
  readonly via: "namespace" | "default" | "require";
  readonly base: readonly string[];
  readonly dynamic?: boolean;
}

function stringValue(node: ts.Expression | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (
    ts.isStringLiteralLike(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.text;
  }
  return undefined;
}

function staticPropertyName(node: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  return ts.isComputedPropertyName(node)
    ? stringValue(node.expression)
    : undefined;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    const { expression: nested } = current;
    current = nested;
  }
  return current;
}

function position(file: ts.SourceFile, module: ScannableModule, node: ts.Node) {
  const offset = node.getStart(file);
  const point = file.getLineAndCharacterOfPosition(offset);
  return {
    module: module.name,
    key: module.key,
    line: point.line + 1,
    column: point.character + 1,
    offset,
  };
}

function callKind(node: ts.Node): BuiltinMemberUse["access"] {
  const outer = node.parent;
  if (outer && ts.isCallExpression(outer) && outer.expression === node) {
    return "call";
  }
  if (outer && ts.isNewExpression(outer) && outer.expression === node) {
    return "construct";
  }
  return "read";
}

export function resolveNamespaceBindings(
  file: ts.SourceFile,
  module: ScannableModule,
  specifier: string,
  initial: ReadonlyMap<string, BindingOrigin>,
  requireBindings: RequireBindings
): {
  readonly bindings: ScopedBindings<BindingOrigin>;
  readonly destructured: readonly BuiltinMemberUse[];
  readonly dynamic: readonly BuiltinDynamicMember[];
} {
  const bindings = new ScopedBindings<BindingOrigin>(file);
  const destructured: BuiltinMemberUse[] = [];
  const destructuredOffsets = new Set<number>();
  const dynamic: BuiltinDynamicMember[] = [];
  const dynamicOffsets = new Set<number>();
  const addDynamic = (
    node: ts.Node,
    via: BuiltinDynamicMember["via"]
  ): void => {
    const at = position(file, module, node);
    if (dynamicOffsets.has(at.offset)) {
      return;
    }
    dynamicOffsets.add(at.offset);
    dynamic.push({ ...at, via, guarded: false });
  };
  const addPattern = (pattern: ts.BindingName, origin: BindingOrigin): void => {
    if (ts.isIdentifier(pattern)) {
      bindings.setOrigin(pattern, origin);
    } else if (ts.isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        if (element.dotDotDotToken) {
          addDynamic(element.dotDotDotToken, origin.via);
          addPattern(element.name, origin);
          continue;
        }
        let key: string | undefined;
        if (element.propertyName) {
          key = staticPropertyName(element.propertyName);
        } else if (ts.isIdentifier(element.name)) {
          key = element.name.text;
        }
        if (key === undefined) {
          addDynamic(element.propertyName ?? element.name, origin.via);
          addPattern(element.name, { ...origin, dynamic: true });
          continue;
        }
        const next = { ...origin, base: [...origin.base, key] };
        const target = element.propertyName ?? element.name;
        if (origin.dynamic) {
          addDynamic(target, origin.via);
        } else {
          const at = position(file, module, target);
          if (!destructuredOffsets.has(at.offset)) {
            destructured.push({
              ...at,
              member: next.base.join("."),
              access: "read",
              via: origin.via,
              guarded: false,
            });
            destructuredOffsets.add(at.offset);
          }
        }
        addPattern(
          element.name,
          origin.dynamic ? { ...next, dynamic: true } : next
        );
      }
    } else if (ts.isArrayBindingPattern(pattern)) {
      addDynamic(pattern, origin.via);
    }
  };

  // Associate initial imports with declaration nodes so a same-named function
  // parameter or block-local can shadow them without leaking the capability.
  // oxlint-disable-next-line eslint/complexity -- This visitor preserves scoped import initialization order.
  const initialize = (node: ts.Node): void => {
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === specifier &&
      (!node.exportClause || ts.isNamespaceExport(node.exportClause))
    ) {
      addDynamic(
        node.exportClause && ts.isNamespaceExport(node.exportClause)
          ? node.exportClause.name
          : node.moduleSpecifier,
        "namespace"
      );
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "then" &&
      isLiteralDynamicImport(node.expression.expression, specifier)
    ) {
      const [callback] = node.arguments;
      if (callback && ts.isFunctionLike(callback)) {
        const [parameter] = callback.parameters;
        if (parameter) {
          addPattern(parameter.name, { via: "namespace", base: [] });
        }
      }
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === specifier &&
      node.importClause
    ) {
      const clause = node.importClause;
      if (clause.name) {
        const origin = initial.get(clause.name.text);
        if (origin) {
          bindings.setOrigin(clause.name, origin);
        }
      }
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        const origin = initial.get(named.name.text);
        if (origin) {
          bindings.setOrigin(named.name, origin);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const call = unwrapExpression(node.initializer);
      if (!ts.isCallExpression(call)) {
        ts.forEachChild(node, initialize);
        return;
      }
      const isDynamicImport =
        call.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = isNodeRequireCall(call, requireBindings);
      const isMetaRequire =
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "require" &&
        ts.isMetaProperty(call.expression.expression);
      const isTarget =
        (isDynamicImport || isRequire || isMetaRequire) &&
        stringValue(call.arguments[0]) === specifier;
      if (isTarget && ts.isIdentifier(node.name)) {
        const origin = isDynamicImport
          ? { via: "namespace" as const, base: [] as readonly string[] }
          : initial.get(node.name.text);
        if (origin) {
          bindings.setOrigin(node.name, origin);
        }
      } else if (
        isTarget &&
        (isDynamicImport || isRequire || isMetaRequire) &&
        (ts.isObjectBindingPattern(node.name) ||
          ts.isArrayBindingPattern(node.name))
      ) {
        addPattern(node.name, {
          via: isDynamicImport ? "namespace" : "require",
          base: [],
        });
      }
    }
    ts.forEachChild(node, initialize);
  };
  initialize(file);

  let declarationCount = 0;
  const countDeclarations = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      declarationCount += 1;
    }
    ts.forEachChild(node, countDeclarations);
  };
  countDeclarations(file);
  for (let pass = 0; pass < declarationCount + 1; pass += 1) {
    let changed = false;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const initializer = unwrapExpression(node.initializer);
        const path = expressionPath(initializer);
        const root = rootIdentifier(initializer);
        const origin = root ? bindings.lookup(root)?.origin : undefined;
        if (path && origin) {
          const next = { ...origin, base: [...origin.base, ...path.path] };
          if (ts.isIdentifier(node.name)) {
            if (!bindings.lookup(node.name)?.origin) {
              bindings.setOrigin(node.name, next);
              changed = true;
            }
          } else {
            const before = destructuredOffsets.size + dynamicOffsets.size;
            addPattern(node.name, next);
            changed ||= destructuredOffsets.size + dynamicOffsets.size > before;
          }
        } else if (root && origin) {
          const next = { ...origin, dynamic: true };
          if (ts.isIdentifier(node.name)) {
            if (!bindings.lookup(node.name)?.origin) {
              bindings.setOrigin(node.name, next);
              changed = true;
            }
          } else {
            const before = destructuredOffsets.size + dynamicOffsets.size;
            addPattern(node.name, next);
            changed ||= destructuredOffsets.size + dynamicOffsets.size > before;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (!changed) {
      break;
    }
  }
  return { bindings, destructured, dynamic };
}

function rootIdentifier(expression: ts.Expression): ts.Identifier | undefined {
  let current = expression;
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current : undefined;
}

function inlineImportOrigin(
  expression: ts.Expression,
  specifier: string
): BindingOrigin | undefined {
  const value = unwrapExpression(expression);
  if (
    ts.isCallExpression(value) &&
    value.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    return isAwaited(value) && stringValue(value.arguments[0]) === specifier
      ? { via: "namespace", base: [] }
      : undefined;
  }
  if (ts.isPropertyAccessExpression(value)) {
    const origin = inlineImportOrigin(value.expression, specifier);
    return origin
      ? { ...origin, base: [...origin.base, value.name.text] }
      : undefined;
  }
  if (ts.isElementAccessExpression(value)) {
    const origin = inlineImportOrigin(value.expression, specifier);
    if (!origin) {
      return undefined;
    }
    const member = stringValue(value.argumentExpression);
    return member === undefined
      ? { ...origin, dynamic: true }
      : { ...origin, base: [...origin.base, member] };
  }
  return undefined;
}

function isAwaited(expression: ts.Expression): boolean {
  let current: ts.Node = expression;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return (
    ts.isAwaitExpression(current.parent) &&
    current.parent.expression === current
  );
}

function isLiteralDynamicImport(
  expression: ts.Expression,
  specifier: string
): boolean {
  const value = unwrapExpression(expression);
  return (
    ts.isCallExpression(value) &&
    value.expression.kind === ts.SyntaxKind.ImportKeyword &&
    stringValue(value.arguments[0]) === specifier
  );
}

// Record the longest static member path once; intermediate receivers are part of that leaf use.
function isAccessReceiver(node: ts.Expression): boolean {
  const { parent } = node;
  return (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  );
}

export function scanNamespaceMemberUses(
  file: ts.SourceFile,
  module: ScannableModule,
  bindings: ScopedBindings<BindingOrigin>,
  specifier: string,
  requireBindings: RequireBindings
): {
  readonly members: readonly BuiltinMemberUse[];
  readonly dynamic: readonly BuiltinDynamicMember[];
} {
  const members: BuiltinMemberUse[] = [];
  const dynamic: BuiltinDynamicMember[] = [];
  const dynamicOffsets = new Set<number>();
  const addDynamic = (
    node: ts.Node,
    via: BuiltinDynamicMember["via"]
  ): void => {
    const at = position(file, module, node);
    if (dynamicOffsets.has(at.offset)) {
      return;
    }
    dynamicOffsets.add(at.offset);
    dynamic.push({ ...at, via, guarded: false });
  };
  // This resolver combines lexical bindings, require calls, inline imports, and
  // dynamic member paths while closing over the current module's scan state.
  // oxlint-disable-next-line eslint/complexity -- These cases form one recursive origin resolver.
  const receiverOrigin = (
    expression: ts.Expression
  ): BindingOrigin | undefined => {
    const value = unwrapExpression(expression);
    if (ts.isIdentifier(value)) {
      return bindings.lookup(value)?.origin;
    }
    if (
      ts.isCallExpression(value) &&
      isNodeRequireCall(value, requireBindings) &&
      stringValue(value.arguments[0]) === specifier
    ) {
      return { via: "require", base: [] };
    }
    const inline = inlineImportOrigin(expression, specifier);
    if (inline) {
      return inline;
    }
    if (
      ts.isPropertyAccessExpression(value) ||
      ts.isElementAccessExpression(value)
    ) {
      const base = receiverOrigin(value.expression);
      if (!base) {
        return undefined;
      }
      const member = ts.isPropertyAccessExpression(value)
        ? value.name.text
        : stringValue(value.argumentExpression);
      return member === undefined
        ? { ...base, dynamic: true }
        : { ...base, base: [...base.base, member] };
    }
    return undefined;
  };
  // This visitor classifies static member reads, aliases, and dynamic accesses
  // against the same binding state and source location model.
  // oxlint-disable-next-line eslint/complexity -- These cases form one ordered use-site scan.
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && !isAccessReceiver(node)) {
      const path = expressionPath(node.expression);
      const origin = receiverOrigin(node.expression);
      if (origin) {
        if (origin.dynamic) {
          addDynamic(node.name, origin.via);
        } else {
          const fullPath = [...origin.base, node.name.text];
          const access = callKind(node);
          members.push({
            ...position(file, module, node.name),
            member: fullPath.join("."),
            access,
            via: origin.via,
            guarded: path
              ? isGuarded(file, node, path.root, fullPath, access, bindings)
              : false,
          });
        }
      }
    } else if (ts.isElementAccessExpression(node) && !isAccessReceiver(node)) {
      const path = expressionPath(node.expression);
      const origin = receiverOrigin(node.expression);
      if (origin) {
        const member = stringValue(node.argumentExpression);
        if (member === undefined || origin.dynamic) {
          addDynamic(node.argumentExpression ?? node, origin.via);
        } else {
          const fullPath = [...origin.base, member];
          const access = callKind(node);
          members.push({
            ...position(file, module, node.argumentExpression ?? node),
            member: fullPath.join("."),
            access,
            via: origin.via,
            guarded: path
              ? isGuarded(file, node, path.root, fullPath, access, bindings)
              : false,
          });
        }
      }
    } else if (ts.isIdentifier(node) && bindings.lookup(node)?.origin) {
      const { parent } = node;
      const isReceiverExpression =
        (ts.isPropertyAccessExpression(parent) ||
          ts.isElementAccessExpression(parent)) &&
        parent.expression === node;
      const isAlias =
        ts.isVariableDeclaration(parent) && parent.initializer === node;
      const isDeclaration =
        (ts.isVariableDeclaration(parent) && parent.name === node) ||
        (ts.isParameter(parent) && parent.name === node) ||
        (ts.isImportClause(parent) && parent.name === node) ||
        (ts.isNamespaceImport(parent) && parent.name === node) ||
        (ts.isImportSpecifier(parent) && parent.name === node);
      if (
        !isReceiverExpression &&
        !isAlias &&
        !isDeclaration &&
        !ts.isBindingElement(parent)
      ) {
        const origin = bindings.lookup(node)?.origin;
        if (origin === undefined) {
          throw new Error("Expected a resolved namespace binding");
        }
        if (origin.base.length) {
          if (origin.dynamic) {
            addDynamic(node, origin.via);
          } else {
            const access = callKind(node);
            members.push({
              ...position(file, module, node),
              member: origin.base.join("."),
              access,
              via: origin.via,
              guarded: isGuarded(
                file,
                node,
                node.text,
                origin.base,
                access,
                bindings
              ),
            });
          }
        } else {
          addDynamic(node, origin.via);
        }
      }
    } else if (
      ts.isCallExpression(node) &&
      isNodeRequireCall(node, requireBindings)
    ) {
      const [argument] = node.arguments;
      const isTarget =
        argument &&
        (ts.isStringLiteralLike(argument) ||
          ts.isNoSubstitutionTemplateLiteral(argument)) &&
        argument.text === specifier;
      const isAssigned =
        ts.isVariableDeclaration(node.parent) &&
        node.parent.initializer === node;
      const isReceiver =
        (ts.isPropertyAccessExpression(node.parent) &&
          node.parent.expression === node) ||
        (ts.isElementAccessExpression(node.parent) &&
          node.parent.expression === node);
      if (isTarget && !isAssigned && !isReceiver) {
        if (argument === undefined) {
          throw new Error("Matched require call without a specifier argument");
        }
        addDynamic(argument, "require");
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      stringValue(node.arguments[0]) === specifier
    ) {
      let outer: ts.Expression = node;
      while (
        outer.parent &&
        (ts.isParenthesizedExpression(outer.parent) ||
          ts.isAwaitExpression(outer.parent)) &&
        outer.parent.expression === outer
      ) {
        outer = outer.parent;
      }
      const { parent } = outer;
      const assigned =
        ts.isVariableDeclaration(parent) && parent.initializer === outer;
      const bare = ts.isExpressionStatement(parent);
      const receiver =
        (ts.isPropertyAccessExpression(parent) ||
          ts.isElementAccessExpression(parent)) &&
        parent.expression === outer;
      const awaitedReceiver = receiver && isAwaited(node);
      const inlineThen =
        receiver &&
        ts.isPropertyAccessExpression(parent) &&
        parent.name.text === "then" &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent &&
        parent.parent.arguments[0] &&
        ts.isFunctionLike(parent.parent.arguments[0]);
      if (!assigned && !bare && !awaitedReceiver && !inlineThen) {
        addDynamic(node, "namespace");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { members, dynamic };
}

export function guardedBunUseLocations(
  modules: readonly ScannableModule[],
  inventory: BunApiInventory
): ReadonlySet<string> {
  const wanted = new Map<
    string,
    Map<number, Map<string, Set<GuardedAccess>>>
  >();
  for (const member of inventory.members) {
    for (const occurrence of member.occurrences) {
      const offsets =
        wanted.get(occurrence.module) ??
        new Map<number, Map<string, Set<GuardedAccess>>>();
      const paths =
        offsets.get(occurrence.offset) ?? new Map<string, Set<GuardedAccess>>();
      const access = paths.get(member.path) ?? new Set<GuardedAccess>();
      access.add(occurrence.access);
      paths.set(member.path, access);
      offsets.set(occurrence.offset, paths);
      wanted.set(occurrence.module, offsets);
    }
  }
  const guarded = new Set<string>();
  for (const module of modules) {
    const expectedByOffset = wanted.get(module.name);
    if (module.loader !== 1 || !module.source || !expectedByOffset) {
      continue;
    }
    const file = ts.createSourceFile(
      module.name,
      module.source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    );
    const lexicalBindings = new ScopedBindings<true>(file);
    const visit = (node: ts.Node): void => {
      const offset = node.getStart(file);
      const expectedPaths = expectedByOffset.get(offset);
      if (
        expectedPaths &&
        (ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node))
      ) {
        const path = expressionPath(node);
        const memberPath = path?.path.join(".");
        const accessKinds = memberPath
          ? expectedPaths.get(memberPath)
          : undefined;
        if (
          path &&
          accessKinds &&
          [...accessKinds].some((access) =>
            isGuarded(file, node, path.root, path.path, access, lexicalBindings)
          )
        ) {
          guarded.add(`${module.name}\0${offset}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return guarded;
}
