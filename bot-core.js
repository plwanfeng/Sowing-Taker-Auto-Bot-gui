const axios = require('axios');
const { ethers } = require('ethers');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
const log = require('electron-log');

const API_BASE_URL = 'https://sowing-api.taker.xyz';
const CONTRACT_ADDRESS = '0xF929AB815E8BfB84Cdab8d1bb53F22eB1e455378';
const CONTRACT_ABI = [
    {
        "constant": false,
        "inputs": [],
        "name": "active",
        "outputs": [],
        "payable": false,
        "stateMutability": "nonpayable",
        "type": "function"
    }
];

const HEADERS = {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    'sec-ch-ua': '"Microsoft Edge";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'Referer': 'https://sowing.taker.xyz/',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function formatTimeRemaining(timestamp) {
    const now = Date.now();
    const timeLeft = timestamp - now;
    if (timeLeft <= 0) return '00:00:00';
    const hours = Math.floor(timeLeft / (1000 * 60 * 60));
    const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function normalizeProxy(proxy) {
    if (!proxy) return null;
    if (!proxy.startsWith('http://') && !proxy.startsWith('https://')) {
        proxy = `http://${proxy}`;
    }
    return proxy;
}

async function apiRequest(url, method = 'GET', data = null, authToken = null, proxy = null) {
    const config = {
        method,
        url,
        headers: { ...HEADERS },
    };
    if (data) config.data = data;
    if (authToken) config.headers['authorization'] = `Bearer ${authToken}`;
    if (proxy) {
        config.httpsAgent = new HttpsProxyAgent(normalizeProxy(proxy));
    }
    try {
        const response = await axios(config);
        return response.data;
    } catch (error) {
        throw new Error(error.response?.data?.message || error.message);
    }
}

async function generateNonce(wallet) {
    const response = await apiRequest(
        `${API_BASE_URL}/wallet/generateNonce`,
        'POST',
        { walletAddress: ethers.utils.getAddress(wallet.address) }, 
        null,
        wallet.proxy
    );
    log.info(`Nonce API 响应: ${JSON.stringify(response)}`);
    if (response.code === 200) {
        if (response.result?.nonce) {
            return response.result.nonce; 
        } else if (typeof response.result === 'string') {
            const nonceMatch = response.result.match(/Nonce: (.*)$/m);
            if (nonceMatch && nonceMatch[1]) {
                return nonceMatch[1];
            }
        }
    }
    throw new Error('生成nonce失败: ' + (response.message || '未知错误'));
}

async function login(wallet, nonce) {
    const checksummedAddress = ethers.utils.getAddress(wallet.address);

    const message = `Taker quest needs to verify your identity to prevent unauthorized access. Please confirm your sign-in details below:\n\naddress: ${checksummedAddress}\n\nNonce: ${nonce}`;
    
    const ethersWallet = new ethers.Wallet(wallet.privateKey);

    log.info(`要签名的消息: ${message}`);

    let signature;
    try {
        signature = await ethersWallet.signMessage(message);
        log.info(`生成的签名: ${signature}`);
    } catch (error) {
        log.error(`签名生成失败: ${error.message}`);
        throw error;
    }

    const response = await apiRequest(
        `${API_BASE_URL}/wallet/login`,
        'POST',
        { address: checksummedAddress, signature, message },
        null,
        wallet.proxy
    );

    log.info(`登录 API 响应: ${JSON.stringify(response)}`);

    if (response.code === 200) {
        return response.result.token;
    }

    log.warn('标准签名失败。尝试 EIP-712 签名...');
    const domain = {
        name: 'Taker',
        version: '1',
        chainId: 1125, 
    };
    const types = {
        Login: [
            { name: 'address', type: 'address' },
            { name: 'nonce', type: 'string' },
        ],
    };
    const value = {
        address: checksummedAddress,
        nonce: nonce,
    };
    
    try {
        signature = await ethersWallet._signTypedData(domain, types, value);
        log.info(`生成的 EIP-712 签名: ${signature}`);
    } catch (error) {
        log.error(`EIP-712 签名生成失败: ${error.message}`);
        throw error;
    }

    const eip712Response = await apiRequest(
        `${API_BASE_URL}/wallet/login`,
        'POST',
        { address: checksummedAddress, signature, message: JSON.stringify({ domain, types, value }) },
        null,
        wallet.proxy
    );

    log.info(`EIP-712 登录 API 响应: ${JSON.stringify(eip712Response)}`);

    if (eip712Response.code === 200) {
        return eip712Response.result.token;
    }

    throw new Error('登录失败: ' + (response.message || eip712Response.message || '签名不匹配'));
}

async function getUserInfo(wallet, token) {
    const response = await apiRequest(
        `${API_BASE_URL}/user/info`,
        'GET',
        null,
        token,
        wallet.proxy
    );
    if (response.code === 200) {
        return response.result;
    }
    throw new Error('获取用户信息失败: ' + response.message);
}

async function performSignIn(wallet, token) {
    try {
        const response = await apiRequest(
            `${API_BASE_URL}/task/signIn?status=true`,
            'GET',
            null,
            token,
            wallet.proxy
        );
        if (response.code === 200) {
            return true;
        }
        const errorMessage = response.message || '服务器返回未知错误';
        log.error(`签到失败: 代码 ${response.code}, 原因: ${errorMessage}`);
        
        // 根据错误代码或消息提供更详细的错误原因
        let detailedError = '';
        if (response.code === 401) {
            detailedError = '认证失败，令牌可能已过期';
        } else if (response.code === 429) {
            detailedError = '请求过于频繁，请稍后重试';
        } else if (response.code >= 500) {
            detailedError = '服务器错误，请稍后重试';
        } else if (errorMessage.includes('limit')) {
            detailedError = '达到签到次数限制';
        } else {
            detailedError = errorMessage;
        }
        
        throw new Error(`签到失败: ${detailedError}`);
    } catch (error) {
        log.error(`签到过程中出错: ${error.message}`);
        return false;
    }
}

async function claimReward(wallet, token) {
    try {
        log.info('开始奖励领取流程...');
        log.info('准备链上交易...');

        const provider = new ethers.providers.JsonRpcProvider('https://rpc-mainnet.taker.xyz', {
            chainId: 1125,
            name: 'Taker',
            nativeCurrency: { name: 'Taker', symbol: 'TAKER', decimals: 18 }
        });

        try {
            // 检查网络连接
            await provider.getNetwork();
        } catch (networkError) {
            log.error(`网络连接错误: ${networkError.message}`);
            throw new Error(`网络连接失败: 无法连接到Taker网络，请检查您的网络连接。详细信息: ${networkError.message}`);
        }

        // 检查账户余额
        try {
            const ethersWallet = new ethers.Wallet(wallet.privateKey, provider);
            const balance = await ethersWallet.getBalance();
            
            if (balance.isZero()) {
                throw new Error('钱包余额为零，无法支付Gas费用');
            }
            
            const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, ethersWallet);

            const gasLimit = 182832;
            const maxPriorityFeePerGas = ethers.utils.parseUnits('0.11', 'gwei');
            const maxFeePerGas = ethers.utils.parseUnits('0.11135', 'gwei');

            log.info('发送交易调用 active()...');
            
            try {
                const tx = await contract.active({
                    gasLimit,
                    maxPriorityFeePerGas,
                    maxFeePerGas,
                    type: 2 
                });

                log.info(`交易已发送: ${tx.hash}`);
                
                try {
                    const receipt = await tx.wait();
                    log.info(`交易已确认: ${receipt.transactionHash} | 使用的 Gas: ${receipt.gasUsed}`);
                } catch (confirmError) {
                    throw new Error(`交易确认失败: ${confirmError.message}`);
                }
            } catch (txError) {
                throw new Error(`交易发送失败: ${txError.message}`);
            }
        } catch (error) {
            log.error(`链上交易错误: ${error.message}`);
            throw error;
        }

        log.info('调用 signIn API 状态为 false...');
        try {
            const signInResponse = await apiRequest(
                `${API_BASE_URL}/task/signIn?status=false`,
                'GET',
                null,
                token,
                wallet.proxy
            );

            if (signInResponse.code === 200) {
                log.info('SignIn API (status=false) 调用成功。');
            } else {
                log.warn(`SignIn API (status=false) 调用失败: 代码 ${signInResponse.code} - ${signInResponse.message || '未知错误'}`);
                throw new Error(`API响应错误 (代码: ${signInResponse.code}): ${signInResponse.message || '未知错误'}`);
            }
        } catch (apiError) {
            if (apiError.message.includes('API响应错误')) {
                throw apiError;
            } else {
                throw new Error(`API通信失败: ${apiError.message}`);
            }
        }

        log.info('奖励领取成功！');
        return true;
    } catch (error) {
        log.error(`领取过程中出错: ${error.message}`);
        return false;
    }
}

module.exports = {
    formatTimeRemaining,
    normalizeProxy,
    generateNonce,
    login,
    getUserInfo,
    performSignIn,
    claimReward
}; 