import { enabledFromString, parseBuildChannel } from "../shared/buildChannel";
import { EXTENSION_NAME } from "../shared/protocol";
import { CodexLogo } from "./CodexLogo";
import { NativeHostStatusCard } from "./NativeHostStatus";

const buildChannel = parseBuildChannel("prod");
const showInternalDetails = buildChannel !== "prod";
const sidePanelEnabled = enabledFromString();

export function App() {
  return (
    <main className="popup">
      <div className="popup-stack">
        <header className="popup-header">
          <CodexLogo className="popup-logo" />
          <h1>{EXTENSION_NAME}</h1>
        </header>
        {sidePanelEnabled ? (
          <button
            className="open-sidepanel-button"
            type="button"
            onClick={openSidePanel}
          >
            Open side panel
          </button>
        ) : null}
        <NativeHostStatusCard showInternalDetails={showInternalDetails} />
      </div>
    </main>
  );
}

async function openSidePanel(): Promise<void> {
  if (chrome.sidePanel == null) {
    throw new Error("Chrome side panel API is unavailable");
  }
  const currentWindow = await chrome.windows.getCurrent();
  if (currentWindow.id == null) {
    throw new Error("Unable to find the current Chrome window");
  }
  await chrome.sidePanel.open({ windowId: currentWindow.id });
  window.close();
}
