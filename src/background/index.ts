import { enabledFromString, parseBuildChannel } from "../shared/buildChannel";
import { randomId, writeStorageArea } from "../shared/chromeAsync";
import {
  EXTENSION_INSTANCE_ID_KEY,
  NATIVE_HOST_STATUS_KEY,
  NATIVE_HOSTS,
  type NativeHostStatus,
} from "../shared/protocol";
import { BrowserControlService } from "./browserControl";
import { NativeTransport } from "./nativeTransport";
import { BrowserRpcPeer } from "./rpc";
import { createRuntimeMessageHandler } from "./runtimeMessages";
import { SidePanelTracker } from "./sidePanel";

const buildChannel = parseBuildChannel("prod");
const nativeHostName = NATIVE_HOSTS[buildChannel];
const sidePanelEnabled = enabledFromString();
const sidePanelTracker = new SidePanelTracker();

function storeNativeHostStatus(status: NativeHostStatus): void {
  writeStorageArea(chrome.storage.local, {
    [NATIVE_HOST_STATUS_KEY]: status,
  }).catch(() => {});
}

const nativeTransport = new NativeTransport(
  nativeHostName,
  storeNativeHostStatus,
);
const browserControl = new BrowserControlService(buildChannel);
const browserRpc = new BrowserRpcPeer(nativeTransport, browserControl);

storeNativeHostStatus(nativeTransport.getStatus());

if (sidePanelEnabled) {
  sidePanelTracker.registerListeners();
}

chrome.runtime.onInstalled.addListener(async () => {
  await writeStorageArea(chrome.storage.local, {
    [EXTENSION_INSTANCE_ID_KEY]: randomId(),
  });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  browserRpc.sendCdpEvent({ source, method, params });
});

browserControl.addDownloadChangeListener((event) => {
  browserRpc.sendDownloadChange(event);
});

chrome.downloads.onCreated.addListener((item) => {
  browserControl.handleDownloadCreated(item);
});

chrome.downloads.onChanged.addListener((delta) => {
  browserControl.handleDownloadChanged(delta);
});

chrome.runtime.onMessage.addListener(
  createRuntimeMessageHandler({
    nativeTransport,
    refreshAndStoreStatus,
    sidePanelTracker,
    browserControl,
  }),
);

function refreshAndStoreStatus(): NativeHostStatus {
  const status = nativeTransport.refreshStatus();
  storeNativeHostStatus(status);
  return status;
}
