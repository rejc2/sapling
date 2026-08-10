/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';

export const devPort = 3015;
export const devUri = `http://localhost:${devPort}`;
const IS_DEV_BUILD = process.env.NODE_ENV === 'development';

export function getWebviewOptions(
  context: vscode.ExtensionContext,
  distFolder: string,
): vscode.WebviewOptions & vscode.WebviewPanelOptions {
  return {
    enableScripts: true,
    retainContextWhenHidden: true,
    // Restrict the webview to only loading content from our extension's output directory.
    localResourceRoots: [
      vscode.Uri.joinPath(context.extensionUri, distFolder),
      vscode.Uri.parse(devUri),
    ],
    portMapping: [{webviewPort: devPort, extensionHostPort: devPort}],
  };
}

/**
 * Get any extra styles to inject into the webview.
 * Important: this is injected into the HTML directly, and should not
 * use any user-controlled data that could be used maliciously.
 */
function getVSCodeCompatibilityStyles(): string {
  const globalStyles = new Map();

  const fontFeatureSettings = vscode.workspace
    .getConfiguration('editor')
    .get<string | boolean>('fontLigatures');
  const validFontFeaturesRegex = /^[0-9a-zA-Z"',\-_ ]*$/;
  if (fontFeatureSettings === true) {
    // no need to specify specific additional settings
  } else if (
    !fontFeatureSettings ||
    typeof fontFeatureSettings !== 'string' ||
    !validFontFeaturesRegex.test(fontFeatureSettings)
  ) {
    globalStyles.set('font-variant-ligatures', 'none');
  } else {
    globalStyles.set('font-feature-settings', fontFeatureSettings);
  }

  const tabSizeSettings = vscode.workspace.getConfiguration('editor').get<number>('tabSize');
  if (typeof tabSizeSettings === 'number') {
    globalStyles.set('--tab-size', tabSizeSettings);
  }

  const globalStylesFlat = Array.from(globalStyles, ([k, v]) => `${k}: ${v};`);
  return `
  html {
    ${globalStylesFlat.join('\n')};
  }`;
}

/**
 * When built in dev mode using vite, files are not written to disk.
 * Instead of manually recreating vite's HTML transforms, we fetch the
 * fully-transformed HTML from the vite dev server and inject our custom content.
 *
 * Note: no CSPs in dev mode. This should not be used in production!
 */
async function fetchDevModeHtml(
  extraStyles: string,
  initialScript: (nonce: string) => string,
  rootClass: string,
  entryPointFile: string,
  placeholderHtml?: string,
): Promise<string> {
  const htmlFile = entryPointFile.replace('.js', '.html');
  const response = await fetch(`${devUri}/${htmlFile}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  let html = await response.text();

  // Inject <base> so relative/absolute URLs resolve to the Vite dev server
  html = html.replace('<head>', `<head>\n<base href="${devUri}/">`);

  // Inject custom styles and scripts before </head>
  const customHead = `
  <style>
      ${getVSCodeCompatibilityStyles()}
      ${extraStyles}
  </style>
  ${initialScript('')}
  `;
  html = html.replace('</head>', `${customHead}\n</head>`);

  // Add rootClass and placeholder to the root div
  html = html.replace(
    '<div id="root"></div>',
    `<div id="root" class="${rootClass}">${placeholderHtml ?? 'loading (dev mode)'}</div>`,
  );

  return html;
}

function devModeErrorHtml(error: Error): string {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <style>
      body {
        font-size: 14px;
        color: tomato;
        font-weight: bold;
        border: 2px solid tomato;
        padding: 20px;
        margin: 20px;
      }
    </style>
  </head>
  <body>
    <div id="root">
Error Loading Dev Mode Webview:
${error.message}
    </div>
  </body>
  </html>`;
}

function devModeShimHtml(rootClass: string, placeholderHtml?: string): string {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <style>
      ${getVSCodeCompatibilityStyles()}
    </style>
  </head>
  <body>
    <div id="root" class="${rootClass}">
      ${placeholderHtml ?? 'loading (dev mode)'}
    </div>
  </body>
  </html>`;
}

/**
 * Sets the HTML content of a webview. In production, this synchronously assigns
 * the final HTML with CSP, scripts, and styles. In dev mode, it synchronously
 * assigns a lightweight loading shim, then fetches the fully-transformed HTML
 * from the Vite dev server and swaps it in when ready.
 */
export function assignWebviewHtml({
  webview,
  context,
  extraStyles,
  initialScript,
  title,
  rootClass,
  extensionRelativeBase,
  entryPointFile,
  cssEntryPointFile,
  placeholderHtml,
}: {
  webview: vscode.Webview;
  context: vscode.ExtensionContext;
  /**
   * CSS to inject into the HTML in a <style> tag
   */
  extraStyles: string;
  /**
   * javascript to inject into the HTML in a <script> tag
   * IMPORTANT: this MUST be sanitized to avoid XSS attacks
   */
  initialScript: (nonce: string) => string;
  /** <head>'s <title> of the webview */
  title: string;
  /** className to apply to the root <div> */
  rootClass: string;
  /** Base directory the webview loads from, where `/` in HTTP requests is relative to */
  extensionRelativeBase: string;
  /** Built entry point .js javascript file name to load, relative to extensionRelativeBase */
  entryPointFile: string;
  /** Built bundle .css file name to load, relative to extensionRelativeBase */
  cssEntryPointFile: string;
  /** Placeholder HTML element to show while the webview is loading */
  placeholderHtml?: string;
}): void {
  // Only allow accessing resources relative to webview dir,
  // and make paths relative to here.
  const baseUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, extensionRelativeBase),
  );

  if (IS_DEV_BUILD) {
    webview.html = devModeShimHtml(rootClass, placeholderHtml);
    fetchDevModeHtml(extraStyles, initialScript, rootClass, entryPointFile, placeholderHtml)
      .then(h => {
        webview.html = h;
      })
      .catch(e => {
        // eslint-disable-next-line no-console
        console.error('Error loading dev mode webview:', e);
        webview.html = devModeErrorHtml(e);
      });
    return;
  }

  const cacheBust = (relativeFile: string) => {
    try {
      const {mtimeMs} = fs.statSync(
        vscode.Uri.joinPath(context.extensionUri, extensionRelativeBase, relativeFile).fsPath,
      );
      return `?v=${mtimeMs}`;
    } catch {
      return '';
    }
  };

  const scriptUri = entryPointFile + cacheBust(entryPointFile);

  // Use a nonce to only allow specific scripts to be run
  const nonce = getNonce();

  const CSP = [
    `default-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    // vscode-webview-ui needs to use style-src-elem without the nonce
    `style-src-elem ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    `img-src ${webview.cspSource} https: data:`,
    `script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    `script-src-elem ${webview.cspSource} 'nonce-${nonce}'`,
    `worker-src ${webview.cspSource} 'nonce-${nonce}' blob:`,
  ].join('; ');

  webview.html = `<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta http-equiv="Content-Security-Policy" content="${CSP}">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<base href="${baseUri}/">
		<title>${title}</title>
		<style>@layer base, components;</style>

		<link href="${cssEntryPointFile}${cacheBust(cssEntryPointFile)}" rel="stylesheet">
    <style>
        ${getVSCodeCompatibilityStyles()}
        ${extraStyles}
    </style>
    ${initialScript(nonce)}
		<script type="module" defer="defer" nonce="${nonce}" src="${scriptUri}"></script>
	</head>
	<body>
		<div id="root" class="${rootClass}">
      ${placeholderHtml ?? 'loading...'}
    </div>
	</body>
	</html>`;
}

function getNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}
