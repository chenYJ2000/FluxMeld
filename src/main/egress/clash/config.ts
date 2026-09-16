import type { EgressSourceModuleMeta } from '../types.ts'

export const CLASH_META: EgressSourceModuleMeta = {
  id: 'clash',
  labelKey: 'egress.sources.clash.label',
  descriptionKey: 'egress.sources.clash.description',
  fields: [
    {
      key: 'clashHost',
      type: 'text',
      labelKey: 'egress.sources.clash.clashHost',
      placeholder: '127.0.0.1',
      helpKey: 'egress.sources.clash.clashHostHelp',
      defaultValue: '127.0.0.1',
    },
    {
      key: 'controllerPort',
      type: 'number',
      labelKey: 'egress.sources.clash.controllerPort',
      placeholder: '9097',
      helpKey: 'egress.sources.clash.controllerPortHelp',
      defaultValue: 9097,
    },
    {
      key: 'proxyPort',
      type: 'number',
      labelKey: 'egress.sources.clash.proxyPort',
      placeholder: '7897',
      helpKey: 'egress.sources.clash.proxyPortHelp',
      defaultValue: 7897,
    },
    {
      key: 'secret',
      type: 'password',
      labelKey: 'egress.sources.clash.secret',
      helpKey: 'egress.sources.clash.secretHelp',
    },
  ],
  capabilities: {
    rotate: true,
    listExits: true,
    expiry: false,
    alwaysOn: true,
  },
}
