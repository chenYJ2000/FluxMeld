import type { EgressSourceModuleMeta } from '../types.ts'

export const IP_POOL_META: EgressSourceModuleMeta = {
  id: 'ip-pool',
  labelKey: 'egress.sources.ipPool.label',
  descriptionKey: 'egress.sources.ipPool.description',
  fields: [
    {
      key: 'baseUrl',
      type: 'text',
      labelKey: 'egress.sources.ipPool.baseUrl',
      placeholder: 'http://127.0.0.1:9000/api/v1',
      helpKey: 'egress.sources.ipPool.baseUrlHelp',
      defaultValue: 'http://127.0.0.1:9000/api/v1',
    },
    {
      key: 'site',
      type: 'text',
      labelKey: 'egress.sources.ipPool.site',
      placeholder: 'glm',
      helpKey: 'egress.sources.ipPool.siteHelp',
      defaultValue: 'glm',
    },
    {
      key: 'minRemainingSeconds',
      type: 'number',
      labelKey: 'egress.sources.ipPool.minRemainingSeconds',
      helpKey: 'egress.sources.ipPool.minRemainingSecondsHelp',
      defaultValue: 120,
      min: 0,
    },
    {
      key: 'emptyPoolWaitMs',
      type: 'number',
      labelKey: 'egress.sources.ipPool.emptyPoolWaitMs',
      helpKey: 'egress.sources.ipPool.emptyPoolWaitMsHelp',
      defaultValue: 20000,
      min: 0,
    },
  ],
  capabilities: {
    rotate: true,
    listExits: true,
    expiry: true,
    alwaysOn: true,
  },
  // Each acquisition candidate is a live lease; a small budget avoids deleting
  // many IPs when the pool keeps handing out unusable ones.
  defaultMaxExitAttempts: 3,
}
