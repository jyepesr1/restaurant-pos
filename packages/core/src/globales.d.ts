// `structuredClone` existe en navegadores, Node y Workers; packages/core no carga los tipos de
// ninguno de ellos, así que se declara aquí.
declare function structuredClone<T>(valor: T): T
