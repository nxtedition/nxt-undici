export function createTestIdRecord() {
  return Object.create(null)
}

export function hasOwnTestId(record, id) {
  return Object.hasOwn(record, id)
}

export function selectPassBaseline(passBaselineAll, envKey) {
  if (
    typeof passBaselineAll !== 'object' ||
    passBaselineAll === null ||
    Array.isArray(passBaselineAll)
  ) {
    throw new TypeError('pass-baseline.json must contain an object.')
  }

  return Object.hasOwn(passBaselineAll, envKey) ? passBaselineAll[envKey] : []
}

export function getPassBaselineError({ ci, isFullRun, passBaseline, envKey }) {
  if (!Array.isArray(passBaseline)) {
    return `pass-baseline.json["${envKey}"] must be an array.`
  }
  if (!ci || !isFullRun || passBaseline.length !== 0) return null

  return `pass-baseline.json is missing or has no "${envKey}" entries — the pass-ratchet is disabled. Regenerate it with --emit-pass-baseline.`
}
