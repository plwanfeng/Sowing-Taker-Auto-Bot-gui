require('dotenv').config();
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');
const { generateNonce, login, getUserInfo, performSignIn, claimReward } = require('./bot-core');

// Configure logger
log.transports.file.level = 'info';
log.transports.console.level = 'info';

// Initialize state
let mainWindow;
const wallets = [];
const tokens = {};
const countdownTimers = {};
let isRunning = false;

// Load environment variables and proxies
function loadConfig() {
  try {
    // Load private keys from .env
    for (let i = 1; ; i++) {
      const key = process.env[`PRIVATE_KEY_${i}`];
      if (!key) break;
      
      try {
        const { ethers } = require('ethers');
        const wallet = new ethers.Wallet(key);
        wallets.push({
          privateKey: key,
          address: wallet.address,
          proxy: null
        });
      } catch (error) {
        log.error(`无效的私钥 PRIVATE_KEY_${i}: ${error.message}`);
      }
    }

    // Load proxies if available
    if (fs.existsSync('proxies.txt')) {
      const proxies = fs.readFileSync('proxies.txt', 'utf-8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
      
      if (proxies.length > 0) {
        // Assign proxies to wallets
        wallets.forEach((wallet, index) => {
          wallet.proxy = proxies[index % proxies.length];
        });
      }
    }

    if (wallets.length === 0) {
      log.error('在.env文件中未找到有效的私钥');
      dialog.showErrorBox('配置错误', '在.env文件中未找到有效的私钥。请在.env文件中添加您的私钥。');
      app.quit();
    }
  } catch (error) {
    log.error('加载配置失败:', error);
    dialog.showErrorBox('配置错误', `加载配置失败: ${error.message}`);
    app.quit();
  }
}

// Create the main window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, 'assets/icon.png'),
    autoHideMenuBar: true,
    menuBarVisible: false
  });

  mainWindow.setMenu(null);

  mainWindow.loadFile('index.html');

  // Open DevTools in development mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Initialize the app
app.whenReady().then(() => {
  loadConfig();
  createWindow();
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handlers
ipcMain.handle('get-wallets', () => {
  return wallets.map(wallet => ({
    address: wallet.address,
    proxy: wallet.proxy || 'None'
  }));
});

ipcMain.handle('start-bot', async () => {
  if (isRunning) return { success: false, message: '机器人已经在运行中' };
  isRunning = true;
  
  try {
    // Clear existing timers
    Object.values(countdownTimers).forEach(timer => clearInterval(timer));
    
    // Send initial status
    mainWindow.webContents.send('log-message', { message: `启动Taker sow自动签到机器人，共 ${wallets.length} 个钱包`, type: 'info' });
    
    // Authenticate all wallets
    for (const wallet of wallets) {
      try {
        mainWindow.webContents.send('log-message', { 
          message: `使用代理: ${wallet.proxy || '无'}`, 
          type: 'info', 
          walletAddress: wallet.address 
        });
        
        const nonce = await generateNonce(wallet);
        mainWindow.webContents.send('log-message', { 
          message: '已生成Nonce: ' + nonce, 
          type: 'info', 
          walletAddress: wallet.address 
        });
        
        const token = await login(wallet, nonce);
        tokens[wallet.address] = token;
        mainWindow.webContents.send('log-message', { 
          message: '登录成功！已获取令牌。', 
          type: 'success', 
          walletAddress: wallet.address 
        });
        
        // Get user info and update UI
        const userInfo = await getUserInfo(wallet, token);
        mainWindow.webContents.send('update-wallet-info', { 
          address: wallet.address, 
          info: userInfo 
        });
        
        // Start farming if needed
        if (!userInfo.nextTimestamp) {
          mainWindow.webContents.send('log-message', { 
            message: '未检测到活跃的签到。开始签到...', 
            type: 'info', 
            walletAddress: wallet.address 
          });
          
          const signInSuccess = await performSignIn(wallet, token);
          if (signInSuccess) {
            const updatedInfo = await getUserInfo(wallet, token);
            mainWindow.webContents.send('update-wallet-info', { 
              address: wallet.address, 
              info: updatedInfo 
            });
            
            if (updatedInfo.nextTimestamp) {
              startCountdown(wallet, token, updatedInfo.nextTimestamp);
            }
          }
        } else if (userInfo.nextTimestamp <= Date.now()) {
          mainWindow.webContents.send('log-message', { 
            message: '签到周期已完成。领取奖励并重新开始...', 
            type: 'info', 
            walletAddress: wallet.address 
          });
          
          processFarmingCycle(wallet, token);
        } else {
          mainWindow.webContents.send('log-message', { 
            message: `签到进行中。签到时间: ${new Date(userInfo.nextTimestamp).toLocaleString()}`, 
            type: 'info', 
            walletAddress: wallet.address 
          });
          
          startCountdown(wallet, token, userInfo.nextTimestamp);
        }
      } catch (error) {
        mainWindow.webContents.send('log-message', { 
          message: '错误: ' + error.message, 
          type: 'error', 
          walletAddress: wallet.address 
        });
      }
    }
    
    return { success: true };
  } catch (error) {
    isRunning = false;
    return { success: false, message: error.message };
  }
});

ipcMain.handle('stop-bot', () => {
  if (!isRunning) return { success: false, message: '机器人未在运行' };
  
  // Clear all timers
  Object.values(countdownTimers).forEach(timer => clearInterval(timer));
  
  isRunning = false;
  mainWindow.webContents.send('log-message', { message: '机器人已停止', type: 'warning' });
  return { success: true };
});

ipcMain.handle('refresh-tokens', async () => {
  try {
    mainWindow.webContents.send('log-message', { message: '手动刷新认证令牌...', type: 'info' });
    
    for (const wallet of wallets) {
      try {
        const nonce = await generateNonce(wallet);
        const token = await login(wallet, nonce);
        tokens[wallet.address] = token;
        
        mainWindow.webContents.send('log-message', { 
          message: '令牌刷新成功！', 
          type: 'success', 
          walletAddress: wallet.address 
        });
        
        // Update user info
        const userInfo = await getUserInfo(wallet, token);
        mainWindow.webContents.send('update-wallet-info', { 
          address: wallet.address, 
          info: userInfo 
        });
      } catch (error) {
        mainWindow.webContents.send('log-message', { 
          message: '令牌刷新失败: ' + error.message, 
          type: 'error', 
          walletAddress: wallet.address 
        });
      }
    }
    
    return { success: true };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// Process a farming cycle (claim and restart)
async function processFarmingCycle(wallet, token) {
  try {
    const claimSuccess = await claimReward(wallet, token);
    
    if (claimSuccess) {
      mainWindow.webContents.send('log-message', { 
        message: '开始新的签到周期...', 
        type: 'info', 
        walletAddress: wallet.address 
      });
      
      const signInSuccess = await performSignIn(wallet, token);
      
      if (signInSuccess) {
        const updatedUserInfo = await getUserInfo(wallet, token);
        mainWindow.webContents.send('update-wallet-info', { 
          address: wallet.address, 
          info: updatedUserInfo 
        });
        
        if (updatedUserInfo.nextTimestamp && updatedUserInfo.nextTimestamp > Date.now()) {
          startCountdown(wallet, token, updatedUserInfo.nextTimestamp);
          return true;
        }
      } else {
        mainWindow.webContents.send('log-message', { 
          message: '完成签到周期失败。原因: 重新签到失败，服务器可能繁忙。稍后将重试。', 
          type: 'warning', 
          walletAddress: wallet.address 
        });
        return false;
      }
    } else {
      mainWindow.webContents.send('log-message', { 
        message: `完成签到周期失败。原因: 奖励领取失败，可能是网络问题或Gas费不足。稍后将重试。`, 
        type: 'warning', 
        walletAddress: wallet.address 
      });
      
      // 延迟一段时间后再次尝试，避免快速连续失败导致重复日志
      setTimeout(async () => {
        await processFarmingCycle(wallet, token);
      }, 60000); // 延迟1分钟后重试
      
      return false;
    }
    
    mainWindow.webContents.send('log-message', { 
      message: '完成签到周期失败。原因: 用户信息更新失败或下一轮签到时间无效。稍后将重试。', 
      type: 'warning', 
      walletAddress: wallet.address 
    });
    
    return false;
  } catch (error) {
    mainWindow.webContents.send('log-message', { 
      message: `签到周期错误: ${error.message}`, 
      type: 'error', 
      walletAddress: wallet.address 
    });
    
    return false;
  }
}

// Start a countdown timer for a wallet
function startCountdown(wallet, token, nextTimestamp) {
  // Clear existing timer if any
  if (countdownTimers[wallet.address]) {
    clearInterval(countdownTimers[wallet.address]);
  }
  
  const updateCountdown = async () => {
    const now = Date.now();
    const timeLeft = nextTimestamp - now;
    
    // Send time update to UI
    mainWindow.webContents.send('update-countdown', { 
      address: wallet.address, 
      timeLeft: timeLeft > 0 ? timeLeft : 0,
      nextTimestamp
    });
    
    if (timeLeft <= 0) {
      mainWindow.webContents.send('log-message', { 
        message: '正在签到中loading...', 
        type: 'success', 
        walletAddress: wallet.address 
      });
      
      clearInterval(countdownTimers[wallet.address]);
      countdownTimers[wallet.address] = null;
      
      await processFarmingCycle(wallet, token);
    }
  };
  
  // Initial update
  updateCountdown();
  
  // Schedule regular updates
  countdownTimers[wallet.address] = setInterval(updateCountdown, 1000);
} 