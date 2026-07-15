import { Expression, Handler, Statement } from "../ast";

/**
 * AST walker. Calls the visitor for every statement and expression in a
 * handler body, depth-first, in source order.
 */

export interface AstVisitor {
  statement?(statement: Statement): void;
  expression?(expression: Expression): void;
}

export function walkHandler(handler: Handler, visitor: AstVisitor): void {
  walkStatements(handler.body, visitor);
}

export function walkStatements(statements: Statement[], visitor: AstVisitor): void {
  for (const statement of statements) {
    walkStatement(statement, visitor);
  }
}

export function walkStatement(statement: Statement, visitor: AstVisitor): void {
  visitor.statement?.(statement);
  switch (statement.kind) {
    case "assignment":
      walkExpression(statement.target, visitor);
      walkExpression(statement.value, visitor);
      break;
    case "call":
      walkExpression(statement.expression, visitor);
      break;
    case "if":
      walkExpression(statement.condition, visitor);
      walkStatements(statement.thenBranch, visitor);
      if (statement.elseBranch) walkStatements(statement.elseBranch, visitor);
      break;
    case "repeatWhile":
      walkExpression(statement.condition, visitor);
      walkStatements(statement.body, visitor);
      break;
    case "repeatWith":
      walkExpression(statement.start, visitor);
      walkExpression(statement.end, visitor);
      walkStatements(statement.body, visitor);
      break;
    case "repeatWithIn":
      walkExpression(statement.list, visitor);
      walkStatements(statement.body, visitor);
      break;
    case "repeatForever":
      walkStatements(statement.body, visitor);
      break;
    case "case":
      walkExpression(statement.subject, visitor);
      for (const branch of statement.branches) {
        for (const label of branch.labels) walkExpression(label, visitor);
        walkStatements(branch.body, visitor);
      }
      if (statement.otherwise) walkStatements(statement.otherwise, visitor);
      break;
    case "put":
      for (const value of statement.values) walkExpression(value, visitor);
      if (statement.target) walkExpression(statement.target, visitor);
      break;
    case "return":
      if (statement.value) walkExpression(statement.value, visitor);
      for (const extra of statement.extra) walkExpression(extra, visitor);
      break;
    case "exit":
    case "exitRepeat":
    case "nextRepeat":
    case "global":
    case "property":
      break;
  }
}

export function walkExpression(expression: Expression, visitor: AstVisitor): void {
  visitor.expression?.(expression);
  switch (expression.kind) {
    case "binary":
      walkExpression(expression.left, visitor);
      walkExpression(expression.right, visitor);
      break;
    case "unary":
      walkExpression(expression.operand, visitor);
      break;
    case "paren":
      walkExpression(expression.expression, visitor);
      break;
    case "callExpression":
      for (const argument of expression.arguments) walkExpression(argument, visitor);
      break;
    case "methodCall":
      walkExpression(expression.receiver, visitor);
      for (const argument of expression.arguments) walkExpression(argument, visitor);
      break;
    case "propertyAccess":
      walkExpression(expression.receiver, visitor);
      break;
    case "index":
      walkExpression(expression.receiver, visitor);
      for (const index of expression.indices) walkExpression(index, visitor);
      if (expression.rangeEnd) walkExpression(expression.rangeEnd, visitor);
      break;
    case "list":
      for (const element of expression.elements) walkExpression(element, visitor);
      break;
    case "propertyList":
      for (const entry of expression.entries) {
        walkExpression(entry.key, visitor);
        walkExpression(entry.value, visitor);
      }
      break;
    case "theOf":
      walkExpression(expression.object, visitor);
      break;
    case "objectRef":
      walkExpression(expression.id, visitor);
      if (expression.castLib) walkExpression(expression.castLib, visitor);
      break;
    case "chunk":
      walkExpression(expression.start, visitor);
      if (expression.end) walkExpression(expression.end, visitor);
      walkExpression(expression.source, visitor);
      break;
    case "countOf":
      if (expression.source) walkExpression(expression.source, visitor);
      break;
    case "lastChunk":
      walkExpression(expression.source, visitor);
      break;
    case "integer":
    case "float":
    case "string":
    case "symbol":
    case "identifier":
    case "the":
      break;
  }
}
