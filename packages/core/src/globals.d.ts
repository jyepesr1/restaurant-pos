// `structuredClone` exists in browsers, Node and Workers; packages/core loads the types of
// none of them, so it is declared here.
declare function structuredClone<T>(value: T): T
