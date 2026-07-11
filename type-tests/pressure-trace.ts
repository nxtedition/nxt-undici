import { interceptors, type TraceWriter } from '../lib/index.js'

const trace: TraceWriter = { write: null }
const pressure = interceptors.pressure({ trace })
const disabledPressure = interceptors.pressure({ trace: null })
const configuredPressure = interceptors.pressure({
  sampleInterval: 0,
  tau: 1000,
  someLo: 0.1,
  someHi: 0.4,
  fullLo: 0.05,
  fullHi: 0.2,
  errLo: 0.1,
  errHi: 0.5,
})

// @ts-expect-error Pressure sampling options are numeric.
interceptors.pressure({ sampleInterval: '200' })
// @ts-expect-error Pressure hysteresis options are numeric.
interceptors.pressure({ someHi: '0.5' })

pressure.close()
disabledPressure.close()
configuredPressure.close()
