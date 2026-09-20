/** Minimal insertion-ordered Deque used by the mux inbox. */
export class Deque {
  #items = []

  pushBack(value) { this.#items.push(value) }

  popFront() { return this.#items.shift() }

  clear() { this.#items.length = 0 }

  get size() { return this.#items.length }
}
