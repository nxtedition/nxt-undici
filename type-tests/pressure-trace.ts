import { interceptors, type TraceWriter } from '../lib/index.js'

const trace: TraceWriter = { write: null }
const pressure = interceptors.pressure({ trace })
const disabledPressure = interceptors.pressure({ trace: null })
pressure.close()
disabledPressure.close()
