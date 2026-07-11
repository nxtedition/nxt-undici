import { test } from 'tap'
import query from '../lib/interceptor/query.js'

function serialize(queryParams) {
  let path
  const dispatch = query()((opts) => {
    path = opts.path
  })

  dispatch({ path: '/', query: queryParams }, {})
  return path
}

test('query replaces lone surrogates in keys and values', (t) => {
  t.equal(
    serialize({
      '\ud800key': '\udc00',
      values: ['valid', '\ud800'],
      emoji: '\ud83d\ude00',
    }),
    '/?%EF%BF%BDkey=%EF%BF%BD&values=valid&values=%EF%BF%BD&emoji=%F0%9F%98%80',
  )
  t.end()
})

test('query preserves fields whose malformed keys normalize equally', (t) => {
  t.equal(
    serialize({ '\ud800': 'first', '\ud801': 'second' }),
    '/?%EF%BF%BD=first&%EF%BF%BD=second',
  )
  t.end()
})
