import './style.scss';

import { SceneDataFragment } from './generated-graphql';
import React, { PropsWithChildren } from 'react';
import { InteractiveToolsTab } from './components';
import { Nav, Tab } from 'react-bootstrap';
import { patch } from './api';
import { enableInteractiveTools, installExtensionApi } from './utils';

installExtensionApi();

interface SceneFileInfoPanelProps {
  scene: SceneDataFragment;
}

/**
 * Stash calls `after` patches with (...componentArgs, result) - componentArgs
 * being React's (props, legacyContext). Chain on `result` so tabs added by
 * other plugins' `after` patches are kept.
 */
function previousOutput(args: unknown[]): React.ReactNode {
  const result = args.length > 2 ? args[args.length - 1] : undefined;
  return React.isValidElement(result) || Array.isArray(result)
    ? result
    : (args[0] as PropsWithChildren<unknown>)?.children;
}

patch.after(
  'ScenePage.Tabs',
  (...args: unknown[]) => {
    const props = args[0] as PropsWithChildren<SceneFileInfoPanelProps>;
    const previous = previousOutput(args);
    if (!enableInteractiveTools(props.scene)) {
      return previous;
    }
    return (
      <>
        {previous}
        <Nav.Item>
          <Nav.Link eventKey="scene-interactive-panel">Interactive</Nav.Link>
        </Nav.Item>
      </>
    );
  },
);

patch.after(
  'ScenePage.TabContent',
  (...args: unknown[]) => {
    const props = args[0] as PropsWithChildren<SceneFileInfoPanelProps>;
    const previous = previousOutput(args);
    if (!enableInteractiveTools(props.scene)) {
      return previous;
    }
    return (
      <>
        {previous}
        <Tab.Pane
          eventKey="scene-interactive-panel"
          className="stash-interactive-tools-tab"
        >
          <InteractiveToolsTab scene={props.scene} />
        </Tab.Pane>
      </>
    );
  },
);
