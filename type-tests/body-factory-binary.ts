import type { BodyFactory } from '../lib/index.js'

const arrayBufferFactory: BodyFactory = () => new ArrayBuffer(8)
const dataViewFactory: BodyFactory = () => new DataView(new ArrayBuffer(8))
const typedArrayFactory: BodyFactory = () => new Uint16Array(4)

void [arrayBufferFactory, dataViewFactory, typedArrayFactory]
