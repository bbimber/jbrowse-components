import React from 'react'
import { Button } from '@storybook/react/demo'
import PluginManager from '@gmod/jbrowse-core/PluginManager'
import TrackSelector from '@gmod/jbrowse-plugin-data-management/src/HierarchicalTrackSelectorDrawerWidget/components/HierarchicalTrackSelector'

import corePlugins from '../corePlugins'
import JBrowseRootModelFactory from '../rootModel'
import configSnapshot from '../../test_data/volvox/config.json'

configSnapshot.configuration = {
  rpc: {
    defaultDriver: 'MainThreadRpcDriver',
  },
  useUrlSession: false,
}
export default {
  title: '<HierarchicalTrackSelectorDrawerWidget>',
  component: Button,
}

function getPluginManager(jbrowse = configSnapshot) {
  const pluginManager = new PluginManager(corePlugins.map(P => new P()))
  pluginManager.createPluggableElements()

  const JBrowseRootModel = JBrowseRootModelFactory(pluginManager)
  const rootModel = JBrowseRootModel.create({
    jbrowse,
  })
  if (rootModel.jbrowse && rootModel.jbrowse.savedSessions.length) {
    const { name } = rootModel.jbrowse.savedSessions[0]
    rootModel.activateSession(name)
  } else {
    rootModel.setDefaultSession()
  }
  pluginManager.setRootModel(rootModel)

  pluginManager.configure()
  return pluginManager
}

export const DefaultConfig = () => {
  const pluginManager = getPluginManager()
  const { rootModel } = pluginManager
  const { session } = rootModel
  const selector = session.addDrawerWidget(
    'HierarchicalTrackSelectorDrawerWidget',
    'hierarchicalTrackSelector',
    { view: session.views[0] },
  )
  return <TrackSelector model={selector} />
}