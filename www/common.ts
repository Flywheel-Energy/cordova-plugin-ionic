/// <reference types="cordova" />

import {
  CallbackFunction,
  CheckForUpdateResponse,
  IAppInfo,
  ICurrentConfig,
  IDeployConfig,
  IPluginBaseAPI,
  ISnapshotInfo,
  ISyncOptions,
} from './IonicCordova';

declare const cordova: Cordova;

const channel = cordova.require('cordova/channel');
channel.createSticky('onIonicProReady');
channel.waitForInitialization('onIonicProReady');

declare const Ionic: any;
declare const WEBVIEW_SERVER_URL: string;
declare const Capacitor: any;

enum UpdateMethod {
  BACKGROUND = 'background',
  AUTO = 'auto',
  NONE = 'none',
}

enum UpdateState {
  Available = 'available',
  Pending = 'pending',
  Ready = 'ready',
}

import {
  FetchManifestResp, IAvailableUpdate,
  ISavedPreferences,
  ManifestFileEntry,
} from './definitions';

import {
  isPluginConfig
} from './guards';


class Path {
    static join(...paths: string[]): string {
        let fullPath: string = paths.shift() || '';
        for (const path of paths) {
            if (fullPath && fullPath.slice(-1) !== '/') {
                fullPath += '/';
            }
            fullPath = path.slice(0, 1) !== '/' ? fullPath + path : fullPath + path.slice(1);
        }
        return fullPath;
    }
}

/**
 * LIVE UPDATE API
 *
 * The plugin API for the live updates feature.
 */

class IonicDeployImpl {

  private readonly appInfo: IAppInfo;
  private _savedPreferences: ISavedPreferences;
  private _fileManager: FileManager = new FileManager();
  private SNAPSHOT_CACHE = 'ionic_built_snapshots';
  private MANIFEST_FILE = 'pro-manifest.json';
  public PLUGIN_VERSION = '5.5.2';

  constructor(appInfo: IAppInfo, preferences: ISavedPreferences) {
    this.appInfo = appInfo;
    this._savedPreferences = preferences;
  }

  async _handleInitialPreferenceState() {
    // make sure we're not going to redirect to a stale version
    await this.cleanupStaleVersions();
    const isOnline = navigator && navigator.onLine;
    if (!isOnline) {
      console.warn('The device appears to be offline. Loading last available version and skipping update checks.');
      this.reloadApp();
      return;
    }

    const updateMethod = this._savedPreferences.updateMethod;
    switch (updateMethod) {
      case UpdateMethod.AUTO:
        // NOTE: call sync with background as override to avoid sync
        // reloading the app and manually reload always once sync has
        // set the correct currentVersionId
        console.log('calling _sync');
        try {
          await this.sync({updateMethod: UpdateMethod.BACKGROUND});
        } catch (e) {
          console.warn(e);
          console.warn('Sync failed. Defaulting to last available version.');
        }
        console.log('calling _reload');
        await this.reloadApp();
        console.log('done _reloading');
        break;
      case UpdateMethod.NONE:
        this.reloadApp();
        break;
      default:
        // NOTE: default anything that doesn't explicitly match to background updates
        await this.reloadApp();
        try {
            this.sync({updateMethod: UpdateMethod.BACKGROUND});
        } catch (e) {
          console.warn(e);
          console.warn('Background sync failed. Unable to check for new updates.');
        }
        return;
    }
  }

  getSnapshotCacheDir(versionId: string): string {
    return new URL(Path.join(this.appInfo.dataDirectory, this.SNAPSHOT_CACHE, versionId)).pathname;
  }

  getBundledAppDir(): string {
    let folder = 'www';
    if (typeof (Capacitor) !== 'undefined') {
      folder = 'public';
    }
    return folder;
  }

  private async _savePrefs(prefs: ISavedPreferences): Promise<ISavedPreferences> {
    return new Promise<ISavedPreferences>(async (resolve, reject) => {
      try {
        cordova.exec(async (savedPrefs: ISavedPreferences) => {
          resolve(savedPrefs);
        }, reject, 'IonicCordovaCommon', 'setPreferences', [prefs]);
      } catch (e) {
        reject(e.message);
      }
    });
  }

  async configure(config: IDeployConfig) {
    if (!isPluginConfig(config)) {
      throw new Error('Invalid Config Object');
    }
    await new Promise((resolve, reject) => {
      cordova.exec(resolve, reject, 'IonicCordovaCommon', 'configure', [config]);
    });
    Object.assign(this._savedPreferences, config);
    this._savePrefs(this._savedPreferences);
  }

  async checkForUpdate(): Promise<CheckForUpdateResponse> {
    const isOnline = navigator && navigator.onLine;
    if (!isOnline) {
      throw new Error('The device is offline.');
    }
    const prefs = this._savedPreferences;
    const appInfo = this.appInfo;
    const endpoint = `${prefs.host}/apps/${prefs.appId}/channels/check-device`;

    const device_details = {
      binary_version: prefs.binaryVersionName,
      device_id: appInfo.device || null,
      platform: appInfo.platform,
      platform_version: appInfo.platformVersion,
      snapshot: prefs.currentVersionId,
      build: prefs.currentBuildId
    };

    const body = {
      channel_name: prefs.channel,
      app_id: prefs.appId,
      device: device_details,
      plugin_version: this.PLUGIN_VERSION,
      manifest: true
    };

    const timeout = new Promise( (resolve, reject) => {
      setTimeout(reject, 5000, 'Request timed out. The device maybe offline.');
    });
    const request = fetch(endpoint, {
      method: 'POST',
      headers: new Headers({
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify(body)
    });

    const resp = await (Promise.race([timeout, request]) as Promise<Response>);

    let jsonResp;
    if (resp.status < 500) {
      jsonResp = await resp.json();
    }
    if (resp.ok) {
      const checkForUpdateResp: CheckForUpdateResponse = jsonResp.data;
      if (checkForUpdateResp.available && checkForUpdateResp.url && checkForUpdateResp.snapshot && checkForUpdateResp.build) {
        prefs.availableUpdate = {
          binaryVersionCode: prefs.binaryVersionCode,
          binaryVersionName: prefs.binaryVersionName,
          channel: prefs.channel,
          state: UpdateState.Available,
          lastUsed: new Date().toISOString(),
          url: checkForUpdateResp.url,
          versionId: checkForUpdateResp.snapshot,
          buildId: checkForUpdateResp.build
        };
        await this._savePrefs(prefs);
      }
      return checkForUpdateResp;
    }

    throw new Error(`Error Status ${resp.status}: ${jsonResp ? jsonResp.error.message : await resp.text()}`);
  }

  async downloadUpdate(progress?: CallbackFunction<number>): Promise<boolean> {
    const prefs = this._savedPreferences;
    if (prefs.availableUpdate && prefs.availableUpdate.state === UpdateState.Available) {
      const { fileBaseUrl, manifestJson } = await this._fetchManifest(prefs.availableUpdate.url, prefs.availableUpdate.versionId);
      let currentManifestJson;
      if (prefs.currentVersionId) {
        try {
          const newUrl = prefs.availableUpdate.url.replace(prefs.availableUpdate.versionId, prefs.currentVersionId);
          console.log('trying to get current manifest file at url: ', newUrl);
          if (newUrl !== prefs.availableUpdate.url) {
            const currentManifestObject = await this._fetchManifest(newUrl, prefs.currentVersionId);
            currentManifestJson = currentManifestObject.manifestJson;
          }
        } catch (e) {
          // doesn't matter if it fails will do a full download instead
          console.log('Was not able to download the current manifest file.', e);
        }
      }
      const filePath = new URL(Path.join(this.appInfo.dataDirectory, this.SNAPSHOT_CACHE, prefs.availableUpdate.versionId)).pathname;
      let size = 0;
      manifestJson.forEach(i => {
        size += i.size;
      });
      let { diffManifest, sameManifest, downloaded } = await this._diffManifests(manifestJson, currentManifestJson, filePath, size, progress);
      if (progress) progress(Number(((downloaded / size) * 100).toFixed(2)));
      downloaded = await this.prepareUpdateDirectory(prefs.availableUpdate.versionId, prefs.currentVersionId, sameManifest, downloaded, size, progress);
      await this._downloadFilesFromManifest(fileBaseUrl, diffManifest,  prefs.availableUpdate.versionId, downloaded, size, progress);
      prefs.availableUpdate.state = UpdateState.Pending;
      await this._savePrefs(prefs);
      return true;
    }
    return false;
  }

  private async _downloadFilesFromManifest(baseUrl: string, manifest: ManifestFileEntry[], versionId: string, downloaded: number, size: number, progress?: CallbackFunction<number>) {
    console.log('Downloading update...');
    const beforeDownloadTimer = new Timer('downloadTimer');
    const downloadFile = async (file: ManifestFileEntry) => {
      const base = new URL(baseUrl);
      const newUrl = new URL(file.href, baseUrl);
      newUrl.search = base.search;
      await this._fileManager.downloadAndWriteFile(newUrl.toString(), Path.join(this.getSnapshotCacheDir(versionId), file.href));
      // Update progress
      downloaded += file.size;
      if (progress) progress(Number(((downloaded / size) * 100).toFixed(2)));
    };

    let downloads = [];
    let count = 0;
    console.log(`About to download ${manifest.length} new files for update.`);
    const maxBatch = 20;
    let numberBatches = Math.round(manifest.length / maxBatch);
    if (manifest.length % maxBatch !== 0) {
      numberBatches = numberBatches + 1;
    }
    for (const entry of manifest) {
      if (downloads.length >= maxBatch) {
        count++;
        await Promise.all(downloads);
        beforeDownloadTimer.diff(`downloaded batch ${count} of ${numberBatches} downloads. Done downloading ${count * maxBatch} of ${manifest.length} files`);
        // add a delay in between downloads to let it clear the cache.
        await this._sleep();
        downloads = [];
      }
      downloads.push(downloadFile(entry));
    }
    if (downloads.length) {
      count++;
      await Promise.all(downloads);
      beforeDownloadTimer.diff(`downloaded batch ${count} of ${numberBatches} downloads. Done downloading all ${manifest.length} files`);
    }
    beforeDownloadTimer.end(`Downloaded ${manifest.length} files`);
  }

  private _sleep() {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve('Done');
      }, 50)
    })
  }

  private async _fetchManifest(url: string, versionId: string): Promise<FetchManifestResp> {
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
    });
    return {
      fileBaseUrl: resp.url,
      manifestJson: await resp.json()
    };
  }

  private async _recursiveFilesInPath(filePath: string, suffix: string = '', folderName: string = '') {
    let fullPath = filePath, filePrefix = '';
    if (suffix) {
      fullPath = fullPath + suffix;
      filePrefix = suffix.substring(1);
    }
    if (folderName) {
      fullPath = fullPath + '/' + folderName;
      if (filePrefix) filePrefix += '/' + folderName;
      else filePrefix += folderName;
    }
    const filesNames = await this._fileManager.getDirectoryFiles(fullPath);
    const files: string[] = [];
    if (filesNames && filesNames.length) {
      filesNames.forEach(fileName => {
        let newFileName = filePrefix + '/' + fileName;
        if (!filePrefix) newFileName = fileName;
        files.push(newFileName);
      })
    }
    const folders = files.filter((fileName) => {
      return !fileName.includes('.');
    });
    for (let i = 0; i < folders.length; i++) {
      const filesInFolder = await this._recursiveFilesInPath(filePath, (filePrefix) ? '/' + filePrefix : filePrefix, folders[i].split('/')[folders[i].split('/').length - 1]);
      if (filesInFolder && filesInFolder.length) {
        filesInFolder.forEach(fileName => {
          files.push(fileName);
        });
      }
    }
    return files;
  }

  private async _diffManifests(newManifest: ManifestFileEntry[], oldManifest: ManifestFileEntry[] | undefined, filePath: string, size: number, progress?:CallbackFunction<number>) {
    try {
      const manifestResp = await fetch(`${WEBVIEW_SERVER_URL}/${this.MANIFEST_FILE}`);
      let bundledManifest: ManifestFileEntry[] = await manifestResp.json();
      if (oldManifest) bundledManifest = oldManifest;
      const bundleManifestStrings = bundledManifest.map(entry => JSON.stringify(entry));
      console.log('new manifest length: ', newManifest.length);
      let diffManifest = newManifest.filter(entry => bundleManifestStrings.indexOf(JSON.stringify(entry)) === -1);
      const files = await this._recursiveFilesInPath(filePath);
      console.log('existing files: ', files.length);
      console.log('starting diffManifest length: ', diffManifest.length);
      let sameManifest = newManifest.filter(entry => bundleManifestStrings.indexOf(JSON.stringify(entry)) > -1);
      const diffManifestCopy = [...diffManifest];
      const sameManifestCopy = [...sameManifest];
      let downloaded = 0;
      sameManifest = sameManifestCopy.filter(currentRow => {
        if (files.indexOf(currentRow.href) > -1) {
          downloaded += currentRow.size;
          if (progress) progress(Number(((downloaded / size) * 100).toFixed(2)));
        }
        return files.indexOf(currentRow.href) === -1;
      });
      diffManifest = diffManifestCopy.filter(currentRow => {
        if (files.indexOf(currentRow.href) > -1) {
          downloaded += currentRow.size;
          if (progress) progress(Number(((downloaded / size) * 100).toFixed(2)));
        }
        return files.indexOf(currentRow.href) === -1;
      });
      console.log('ending diffManifest length: ', diffManifest.length);
      // loop through files already there in the files left and filter it down more. (for both same and diff)
      return {diffManifest, sameManifest, downloaded};
    } catch (e) {
      return {diffManifest: newManifest, sameManifest: newManifest.filter(() => false), downloaded: 0};
    }
  }

  private async prepareUpdateDirectory(versionId: string, currentVersionId: string | undefined, manifest: ManifestFileEntry[], downloaded: number, size: number, progress?: CallbackFunction<number>) {

    await this._copyBaseAppDir();
    console.log('Copied base app resources');

    let passedInFolder = 'base';
    if (currentVersionId) passedInFolder = currentVersionId;
    await this._fileManager.copyFiles({
      source: new URL(Path.join(this.appInfo.dataDirectory, this.SNAPSHOT_CACHE,  'base')).pathname + '/plugins',
      target: this.getSnapshotCacheDir(versionId) + '/plugins'
    });
    downloaded = await this._copyCurrentAppDir(passedInFolder, versionId, manifest, downloaded, size, progress);
    console.log('Copied current app resources');
    return downloaded;
  }

  async extractUpdate(progress?: CallbackFunction<number>): Promise<boolean> {
    const prefs = this._savedPreferences;
    if (!prefs.availableUpdate || prefs.availableUpdate.state !== UpdateState.Pending) {
      return false;
    }

    if (progress) {
      progress(100);
    }

    prefs.availableUpdate.state = UpdateState.Ready;
    prefs.updates[prefs.availableUpdate.versionId] = prefs.availableUpdate;
    await this._savePrefs(prefs);
    return true;
  }

  async reloadApp(): Promise<boolean> {
    const prefs = this._savedPreferences;

    // Save the current update if it's ready
    if (prefs.availableUpdate && prefs.availableUpdate.state === UpdateState.Ready) {
      prefs.currentVersionId = prefs.availableUpdate.versionId;
      prefs.currentBuildId = prefs.availableUpdate.buildId;
      delete prefs.availableUpdate;
      await this._savePrefs(prefs);
    }

    // Is there a non-binary version deployed?
    if (prefs.currentVersionId) {
      // Are we already running the deployed version?
      if (await this._isRunningVersion(prefs.currentVersionId)) {
        console.log(`Already running version ${prefs.currentVersionId}`);
        await this._savePrefs(prefs);
        channel.onIonicProReady.fire();
        Ionic.WebView.persistServerBasePath();
        await this.cleanupVersions();
        return false;
      }

      // Is the current version on the device?
      if (!(prefs.currentVersionId in prefs.updates)) {
        console.error(`Missing version ${prefs.currentVersionId}`);
        channel.onIonicProReady.fire();
        return false;
      }

      // Reload the webview
      const newLocation = this.getSnapshotCacheDir(prefs.currentVersionId);
      Ionic.WebView.setServerBasePath(newLocation);
      return true;
    }

    channel.onIonicProReady.fire();
    return false;
  }

  // compare an update to the current version using both name & code
  private isUpdateForCurrentBinary(update: IAvailableUpdate) {
    const currentVersionCode = this._savedPreferences.binaryVersionCode;
    const currentVersionName = this._savedPreferences.binaryVersionName;
    console.log(`Current: versionCode: ${currentVersionCode} versionName: ${currentVersionName}`);
    console.log(`update: versionCode: ${update.binaryVersionCode} versionName: ${update.binaryVersionName}`);
    return update.binaryVersionName === currentVersionName && update.binaryVersionCode === currentVersionCode;
  }

  private isUpdateCurrentlyInstalled(update: IAvailableUpdate) {
    return this._savedPreferences.currentVersionId === update.versionId;
  }

  private async cleanupStaleVersions() {
    const updates = this.getStoredUpdates();
    const prefs = this._savedPreferences;

    for (const update of updates) {
      // Is the version built from a previous binary?
      if (!this.isUpdateForCurrentBinary(update) && !(await this._isRunningVersion(update.versionId))) {
        console.log(
          `Update ${update.versionId} was built for different binary version removing update from device` +
          `Update binaryVersionName: ${update.binaryVersionName}, Device binaryVersionName ${prefs.binaryVersionName}` +
          `Update binaryVersionCode: ${update.binaryVersionCode}, Device binaryVersionCode ${prefs.binaryVersionCode}`
        );

        // This is no longer necessary for this function, but a previous version of the code
        // deleted `prefs.currentVersionId` near initialization so other code may rely on still
        // deleting `prefs.currentVersionId`.
        if (this.isUpdateCurrentlyInstalled(update)) {
          delete prefs.currentVersionId;
        }

        await this.deleteVersionById(update.versionId);
      }
    }
  }

  private async _isRunningVersion(versionId: string) {
    const currentPath = await this._getServerBasePath();
    return currentPath.includes(versionId);
  }

  private async _getServerBasePath(): Promise<string> {
    return new Promise<string>( async (resolve, reject) => {
      try {
        Ionic.WebView.getServerBasePath(resolve);
      } catch (e) {
       reject(e);
      }
    });
  }

  private async _cleanSnapshotDir(versionId: string) {
    const timer = new Timer('CleanSnapshotDir');
    const snapshotDir = this.getSnapshotCacheDir(versionId);
    try {
      await this._fileManager.remove(snapshotDir);
      timer.end();
    } catch (e) {
      console.log('No directory found for snapshot no need to delete');
      timer.end();
    }
  }

  private async _copyBaseAppDir() {
    const timer = new Timer('CopyBaseApp');
    await this._fileManager.copyTo({
      source: {
        path: this.getBundledAppDir(),
        directory: 'APPLICATION',
      },
      target: this.getSnapshotCacheDir('base'),
    });
    timer.end();
  }

  private async _copyCurrentAppDir(folderToCopyFrom: string, versionId: string, manifest: ManifestFileEntry[], downloaded: number, size: number, progress?: CallbackFunction<number>) {
    const timer = new Timer('CopyCurrentApp');
    for (let i = 0; i < manifest.length; i++) {
      await this._fileManager.copyFiles({
        source: new URL(Path.join(this.appInfo.dataDirectory, this.SNAPSHOT_CACHE,  folderToCopyFrom)).pathname + '/' + manifest[i].href,
        target: this.getSnapshotCacheDir(versionId) + '/' + manifest[i].href
      });
      // Update progress
      downloaded += manifest[i].size;
      if (progress) progress(Number(((downloaded / size) * 100).toFixed(2)));
    }
    timer.end();
    return downloaded;
  }

  async getCurrentVersion(): Promise<ISnapshotInfo | undefined> {
    const versionId = this._savedPreferences.currentVersionId;
    if (typeof versionId === 'string') {
      return this.getVersionById(versionId);
    }
    return;
  }

  async getVersionById(versionId: string): Promise<ISnapshotInfo | undefined> {
    const update = this._savedPreferences.updates[versionId];
    if (!update) {
      return;
    }
    return this._convertToSnapshotInfo(update);
  }

  private _convertToSnapshotInfo(update: IAvailableUpdate): ISnapshotInfo {
    return {
      deploy_uuid: update.versionId,
      versionId: update.versionId,
      buildId: update.buildId,
      channel: update.channel,
      binary_version: update.binaryVersionName,
      binaryVersion: update.binaryVersionName,
      binaryVersionCode: update.binaryVersionCode,
      binaryVersionName: update.binaryVersionName
    };
  }

  async getAvailableVersions(): Promise<ISnapshotInfo[]> {
    return Object.keys(this._savedPreferences.updates).map(k => this._convertToSnapshotInfo(this._savedPreferences.updates[k]));
  }

  async deleteVersionById(versionId: string): Promise<boolean> {
    const prefs = this._savedPreferences;

    delete prefs.updates[versionId];
    await this._savePrefs(prefs);

    // delete snapshot directory
    await this._cleanSnapshotDir(versionId);

    return true;
  }

  private getStoredUpdates() {
    // get an array of stored updates
    const prefs = this._savedPreferences;
    const updates = [];
    for (const versionId of Object.keys(prefs.updates)) {
      updates.push(prefs.updates[versionId]);
    }
    return updates;
  }

  private async cleanupVersions() {
    await this.cleanupStaleVersions();

    const prefs = this._savedPreferences;
    // get updates which now have no stale versions
    // filter out the current running version
    // clean down to Max Updates stored

    const updatesToDelete = this.getStoredUpdates().filter((a) => !this.isUpdateCurrentlyInstalled(a))
                    .sort((a, b) => a.lastUsed.localeCompare(b.lastUsed))
                    .reverse()
                    .slice(prefs.maxVersions);

    for (const update of updatesToDelete) {
      await this.deleteVersionById(update.versionId);
    }
  }

  async sync(syncOptions: ISyncOptions = {}, progress?: CallbackFunction<number>): Promise<ISnapshotInfo | undefined> {
    const prefs = this._savedPreferences;

    // TODO: Get API override if present?
    const updateMethod = syncOptions.updateMethod || prefs.updateMethod;

    const wrappedProgress = progress ? (complete?: number) => {
      progress(complete);
    } : undefined;

    await this.checkForUpdate();

    if (prefs.availableUpdate) {
      if (prefs.availableUpdate.state === UpdateState.Available) {
        await this.downloadUpdate(wrappedProgress);
      }
      if (prefs.availableUpdate.state === UpdateState.Pending) {
        // ignore progress from this since it's trivial
        await this.extractUpdate();
      }
      if (prefs.availableUpdate.state === UpdateState.Ready && updateMethod === UpdateMethod.AUTO) {
        await this.reloadApp();
      }
    }

    if (prefs.currentVersionId && prefs.currentBuildId) {
      return {
        deploy_uuid: prefs.currentVersionId,
        versionId: prefs.currentVersionId,
        buildId: prefs.currentBuildId,
        channel: prefs.channel,
        binary_version: prefs.binaryVersionName,
        binaryVersion: prefs.binaryVersionName,
        binaryVersionCode: prefs.binaryVersionCode,
        binaryVersionName: prefs.binaryVersionName
      };
    }
    return;
  }
}

class FileManager {
  async copyTo(options: { source: { directory: string; path: string; } , target: string}) {
    return new Promise<void>( (resolve, reject) => {
      cordova.exec(resolve, reject, 'IonicCordovaCommon', 'copyTo', [options]);
    });
  }

  async remove(path: string) {
    return new Promise<void>( (resolve, reject) => {
      cordova.exec(resolve, reject, 'IonicCordovaCommon', 'remove', [{target: path}]);
    });
  }

  async downloadAndWriteFile(url: string, path: string) {
    return new Promise<void>( (resolve, reject) => {
      cordova.exec(resolve, reject, 'IonicCordovaCommon', 'downloadFile', [{url, target: path}]);
    });
  }

  async copyFiles(options: {source: string, target: string}) {
    return new Promise<void>((resolve, reject) => {
      cordova.exec(resolve, reject, 'IonicCordovaCommon', 'copyFiles', [options]);
    })
  }

  async getDirectoryFiles(path: string) {
    return new Promise<string[]>((resolve, reject) => {
      const options = {
        path: path
      }
      cordova.exec(resolve, reject, 'IonicCordovaCommon', 'getDirectoryFiles', [options]);
    })
  }
}



class IonicDeploy implements IDeployPluginAPI {
  private parent: IPluginBaseAPI;
  private delegate: Promise<IonicDeployImpl>;
  private fetchIsAvailable: boolean;
  private lastPause = 0;
  private minBackgroundDuration = 10;
  private disabled = false;

  constructor(parent: IPluginBaseAPI) {
    this.parent = parent;
    this.delegate = this.initialize();
    this.fetchIsAvailable = typeof(fetch) === 'function';
    document.addEventListener('deviceready', this.onLoad.bind(this));
  }

  async initialize() {
    const preferences = await this._initPreferences();
    this.minBackgroundDuration = preferences.minBackgroundDuration;
    this.disabled = preferences.disabled || !this.fetchIsAvailable;
    const appInfo = await this.parent.getAppDetails();
    const delegate = new IonicDeployImpl(appInfo, preferences);
    // Only initialize start the plugin if fetch is available and DisableDeploy preference is false
    if (this.disabled) {
      let disabledMessage = 'cordova-plugin-ionic has been disabled.';
      if (!this.fetchIsAvailable) {
        disabledMessage = 'Fetch is unavailable so ' + disabledMessage;
      }
      console.warn(disabledMessage);
      channel.onIonicProReady.fire();
    } else {
      await delegate._handleInitialPreferenceState();
    }

    return delegate;
  }

  async onLoad() {
    document.addEventListener('pause', this.onPause.bind(this));
    document.addEventListener('resume', this.onResume.bind(this));
    await this.onResume();
  }

  async onPause() {
    this.lastPause = Date.now();
  }

  async onResume() {
    if (!this.disabled && this.lastPause && this.minBackgroundDuration && Date.now() - this.lastPause > this.minBackgroundDuration * 1000) {
      await (await this.delegate)._handleInitialPreferenceState();
    }
  }

  async _initPreferences(): Promise<ISavedPreferences> {
    return new Promise<ISavedPreferences>(async (resolve, reject) => {
      try {
        channel.onNativeReady.subscribe(async () => {
          // timeout to let browser proxy to init
          window.setTimeout(function () {
            cordova.exec(async (prefs: ISavedPreferences) => {
              resolve(prefs);
            }, reject, 'IonicCordovaCommon', 'getPreferences');
          }, 0);
        });
      } catch (e) {
        channel.onIonicProReady.fire();
        reject(e.message);
      }
    });
  }

  async checkForUpdate(): Promise<CheckForUpdateResponse> {
    if (!this.disabled) {
      return (await this.delegate).checkForUpdate();
    }
    return  {available: false, compatible: false, partial: false};
  }

  async configure(config: IDeployConfig): Promise<void> {
    if (!this.disabled) return (await this.delegate).configure(config);
  }

  async getConfiguration(): Promise<ICurrentConfig> {
    return new Promise<ICurrentConfig>(async (resolve, reject) => {
      try {
        cordova.exec(async (prefs: ISavedPreferences) => {
          if (prefs.availableUpdate) {
            delete prefs.availableUpdate;
          }
          if (prefs.updates) {
            delete prefs.updates;
          }
          resolve(prefs);
        }, reject, 'IonicCordovaCommon', 'getPreferences');
      } catch (e) {
        reject(e.message);
      }
    });
  }

  async deleteVersionById(version: string): Promise<boolean> {
    if (!this.disabled) return (await this.delegate).deleteVersionById(version);
    return true;
  }

  async downloadUpdate(progress?: CallbackFunction<number>): Promise<boolean> {
    if (!this.disabled) return (await this.delegate).downloadUpdate(progress);
    return false;
  }

  async extractUpdate(progress?: CallbackFunction<number>): Promise<boolean> {
    if (!this.disabled) return (await this.delegate).extractUpdate(progress);
    return false;
  }

  async getAvailableVersions(): Promise<ISnapshotInfo[]> {
    if (!this.disabled) return (await this.delegate).getAvailableVersions();
    return [];
  }

  async getCurrentVersion(): Promise<ISnapshotInfo | undefined> {
    if (!this.disabled) return (await this.delegate).getCurrentVersion();
    return;
  }

  async getVersionById(versionId: string): Promise<ISnapshotInfo | undefined> {
    if (!this.disabled) return (await this.delegate).getVersionById(versionId);
    return;
  }

  async reloadApp(): Promise<boolean> {
    if (!this.disabled) return (await this.delegate).reloadApp();
    return false;
  }

  async sync(syncOptions: ISyncOptions = {}, progress?: CallbackFunction<number>): Promise<ISnapshotInfo | undefined> {
    if (!this.disabled) return (await this.delegate).sync(syncOptions, progress);
    return;
  }
}


/**
 * BASE API
 *
 * All features of the Ionic Cordova plugin are registered here, along with some low level error tracking features used
 * by the monitoring service.
 */
class IonicCordova implements IPluginBaseAPI {

  public deploy: IDeployPluginAPI;

  constructor() {
    this.deploy = new IonicDeploy(this);
  }


  getAppInfo(success: CallbackFunction<IAppInfo>, failure: CallbackFunction<string>) {
    console.warn('This function has been deprecated in favor of IonicCordova.getAppDetails.');
    this.getAppDetails().then(
      result => success(result),
      err => {
        typeof err === 'string' ? failure(err) : failure(err.message);
      }
    );
  }

  async getAppDetails(): Promise<IAppInfo> {
    return new Promise<IAppInfo>( (resolve, reject) => {
      cordova.exec(resolve, reject, 'IonicCordovaCommon', 'getAppInfo');
    });
  }
}

class Timer {
  name: string;
  startTime: Date;
  lastTime: Date;
  constructor(name: string) {
    this.name = name;
    this.startTime = new Date();
    this.lastTime = new Date();
    console.log(`Starting IonicTimer ${this.name}`);
  }

  end(extraLog?: string) {
    console.log(`Finished IonicTimer ${this.name} in ${(new Date().getTime() - this.startTime.getTime()) / 1000} seconds.`);
    if (extraLog) {
      console.log(`IonicTimer extra ${extraLog}`);
    }
  }

  diff(message?: string) {
    console.log(`Message: ${message} Diff IonicTimer ${this.name} in ${(new Date().getTime() - this.lastTime.getTime()) / 1000} seconds.`);
    this.lastTime = new Date();
  }
}

const instance = new IonicCordova();
export = instance;
