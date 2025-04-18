const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('api', {
  // Wallet management
  getWallets: () => ipcRenderer.invoke('get-wallets'),
  
  // Bot controls
  startBot: () => ipcRenderer.invoke('start-bot'),
  stopBot: () => ipcRenderer.invoke('stop-bot'),
  refreshTokens: () => ipcRenderer.invoke('refresh-tokens'),
  
  // Event handlers
  onLogMessage: (callback) => ipcRenderer.on('log-message', (_, data) => callback(data)),
  onUpdateWalletInfo: (callback) => ipcRenderer.on('update-wallet-info', (_, data) => callback(data)),
  onUpdateCountdown: (callback) => ipcRenderer.on('update-countdown', (_, data) => callback(data)),
}); 