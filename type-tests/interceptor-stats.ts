import {
  Agent,
  getDispatcherStats,
  getGlobalDispatcherStats,
  interceptors,
  type DnsStats,
  type LookupStats,
  type PriorityStats,
  type RedirectStats,
  type RetryStats,
} from '../lib/index.js'

const priority: PriorityStats[] = interceptors.priority().stats()
const redirect: RedirectStats = interceptors.redirect().stats()
const dns: DnsStats = interceptors.dns().stats()
const lookup: LookupStats = interceptors.lookup().stats()
const retry: RetryStats = interceptors.responseRetry().stats()
const global = getGlobalDispatcherStats()
const dispatcher = getDispatcherStats(new Agent())

priority[0]?.queues[0]?.completed
redirect.followed
dns.negativeHits
lookup.pending
retry.bodyRetries
global.priority
global.redirect
global.dns
global.lookup
global.retry
dispatcher.cache
dispatcher.pressure
dispatcher.retry
