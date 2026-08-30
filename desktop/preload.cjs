const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('constellationDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  runtime: `Electron ${process.versions.electron}`,
}));
