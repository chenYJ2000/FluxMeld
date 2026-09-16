import type { EgressSourceModuleMeta } from '../types.ts'

export const CONFIG_FILE_META: EgressSourceModuleMeta = {
  id: 'config-file',
  labelKey: 'egress.sources.configFile.label',
  descriptionKey: 'egress.sources.configFile.description',
  fields: [
    {
      key: 'filePath',
      type: 'file',
      labelKey: 'egress.sources.configFile.filePath',
      helpKey: 'egress.sources.configFile.filePathHelp',
    },
  ],
  capabilities: {
    rotate: true,
    listExits: true,
    expiry: false,
    alwaysOn: true,
  },
}
