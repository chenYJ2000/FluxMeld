import type { EgressSourceModuleMeta } from '../types.ts'

export const CLASH_META: EgressSourceModuleMeta = {
  id: 'clash',
  labelKey: 'egress.sources.clash.label',
  descriptionKey: 'egress.sources.clash.description',
  fields: [
    {
      key: 'controllerUrl',
      type: 'text',
      labelKey: 'egress.sources.clash.controllerUrl',
      placeholder: '127.0.0.1:9097',
      helpKey: 'egress.sources.clash.controllerUrlHelp',
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
