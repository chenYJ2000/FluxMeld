import type { EgressSourceModuleMeta } from '../types.ts'

export const NETFOUNTAIN_META: EgressSourceModuleMeta = {
  id: 'netfountain',
  labelKey: 'egress.sources.netfountain.label',
  descriptionKey: 'egress.sources.netfountain.description',
  fields: [
    {
      key: 'baseUrl',
      type: 'text',
      labelKey: 'egress.sources.netfountain.baseUrl',
      placeholder: 'http://127.0.0.1:9000/api/v1',
      helpKey: 'egress.sources.netfountain.baseUrlHelp',
      defaultValue: 'http://127.0.0.1:9000/api/v1',
    },
    {
      key: 'site',
      type: 'text',
      labelKey: 'egress.sources.netfountain.site',
      placeholder: 'glm',
      helpKey: 'egress.sources.netfountain.siteHelp',
      defaultValue: 'glm',
    },
    {
      key: 'minRemainingSeconds',
      type: 'number',
      labelKey: 'egress.sources.netfountain.minRemainingSeconds',
      helpKey: 'egress.sources.netfountain.minRemainingSecondsHelp',
      defaultValue: 120,
      min: 0,
    },
    {
      key: 'emptyPoolWaitMs',
      type: 'number',
      labelKey: 'egress.sources.netfountain.emptyPoolWaitMs',
      helpKey: 'egress.sources.netfountain.emptyPoolWaitMsHelp',
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
