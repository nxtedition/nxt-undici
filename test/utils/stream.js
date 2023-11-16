import { Readable, Writable } from 'node:stream'

export function createReadable(data) {
  return new Readable({
    read() {
      this.push(Buffer.from(data))
      this.push(null)
    },
  })
}

export function createWritable(target) {
  return new Writable({
    write(chunk, _, callback) {
      target.push(chunk.toString())
      callback()
    },
    final(callback) {
      callback()
    },
  })
}
