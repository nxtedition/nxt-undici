import {
  getGlobalDispatcherStats,
  interceptors,
  type DnsStats,
  type LookupStats,
  type PriorityStats,
  type RedirectStats,
} from '../lib/index.js'

const priority: PriorityStats[] = interceptors.priority().stats()
const redirect: RedirectStats = interceptors.redirect().stats()
const dns: DnsStats = interceptors.dns().stats()
const lookup: LookupStats = interceptors.lookup().stats()
const global = getGlobalDispatcherStats()

priority[0]?.queues[0]?.completed
redirect.followed
dns.negativeHits
lookup.pending
global.priority
global.redirect
global.dns
global.lookup
