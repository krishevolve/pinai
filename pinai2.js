const fs = require('fs');
const path = require('path');
const axios = require('axios');
const colors = require('colors');
const readline = require('readline');
const { DateTime } = require('luxon');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

class PinaiWorker {
    constructor(accountData, proxy, accountIndex) {
        this.headers = {
            "Accept": "application/json",
            "Accept-Encoding": "gzip, deflate, br",
            "Accept-Language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
            "Content-Type": "application/json",
            "Origin": "https://web.pinai.tech",
            "Referer": "https://web.pinai.tech/",
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1",
            "Lang": "vi"
        };
        this.tokenFilePath = path.join(__dirname, 'token.json');
        this.accountData = accountData;
        this.proxy = proxy;
        this.accountIndex = accountIndex;
        this.proxyIP = null;
    }

    async log(msg, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const accountPrefix = `[Tài khoản ${this.accountIndex + 1}]`;
        const ipPrefix = this.proxyIP ? `[${this.proxyIP}]` : '[Unknown IP]';
        let logMessage = '';
        
        switch(type) {
            case 'success':
                logMessage = `${accountPrefix}${ipPrefix} ${msg}`.green;
                break;
            case 'error':
                logMessage = `${accountPrefix}${ipPrefix} ${msg}`.red;
                break;
            case 'warning':
                logMessage = `${accountPrefix}${ipPrefix} ${msg}`.yellow;
                break;
            default:
                logMessage = `${accountPrefix}${ipPrefix} ${msg}`.blue;
        }
        
        console.log(`[${timestamp}] ${logMessage}`);
    }

    async checkProxyIP(proxy) {
        try {
            const proxyAgent = new HttpsProxyAgent(proxy);
            const response = await axios.get('https://api.ipify.org?format=json', {
                httpsAgent: proxyAgent,
                timeout: 10000
            });
            if (response.status === 200) {
                return response.data.ip;
            }
            throw new Error(`Không thể kiểm tra IP proxy. Status code: ${response.status}`);
        } catch (error) {
            throw new Error(`Lỗi kiểm tra IP proxy: ${error.message}`);
        }
    }

    createAxiosInstance(proxy) {
        const proxyAgent = new HttpsProxyAgent(proxy);
        return axios.create({
            httpsAgent: proxyAgent,
            timeout: 30000,
            headers: this.headers
        });
    }

    isExpired(token) {
        const [header, payload, sign] = token.split('.');
        const decodedPayload = Buffer.from(payload, 'base64').toString();
        
        try {
            const parsedPayload = JSON.parse(decodedPayload);
            const now = Math.floor(DateTime.now().toSeconds());
            
            if (parsedPayload.exp) {
                const expirationDate = DateTime.fromSeconds(parsedPayload.exp).toLocal();
                this.log(`Token hết hạn vào: ${expirationDate.toFormat('yyyy-MM-dd HH:mm:ss')}`);
                
                const isExpired = now > parsedPayload.exp;
                this.log(`Token đã hết hạn chưa? ${isExpired ? 'Đúng rồi bạn cần thay token' : 'Chưa..chạy tẹt ga đi'}`);
                
                return isExpired;
            }
            this.log(`Token vĩnh cửu`, 'warning');
            return false;
        } catch (error) {
            this.log(`Lỗi kiểm tra token: ${error.message}`, 'error');
            return true;
        }
    }

    async loginToPinaiAPI(initData, proxy) {
        const url = "https://prod-api.pinai.tech/passport/login/telegram";
        const payload = {
            "invite_code": "pCqDaDD",
            "init_data": initData
        };

        try {
            const axiosInstance = this.createAxiosInstance(proxy);
            const response = await axiosInstance.post(url, payload);
            if (response.status === 200) {
                const { access_token } = response.data;
                this.log(`Đăng nhập thành công, lưu token...`, 'success');
                return access_token;
            }
            this.log(`Đăng nhập không thành công: ${response.data.msg}`, 'error');
            return null;
        } catch (error) {
            this.log(`Lỗi đăng nhập: ${error.message}`, 'error');
            return null;
        }
    }

    saveAccessToken(userId, token) {
        let tokenData = {};
        if (fs.existsSync(this.tokenFilePath)) {
            tokenData = JSON.parse(fs.readFileSync(this.tokenFilePath, 'utf8'));
        }
        tokenData[userId] = { access_token: token };
        fs.writeFileSync(this.tokenFilePath, JSON.stringify(tokenData, null, 2));
        this.log(`Đã lưu token cho tài khoản ${userId}`, 'success');
    }

    async getHomeData(token, hoinangcap, proxy) {
        const url = "https://prod-api.pinai.tech/home";
        const axiosInstance = this.createAxiosInstance(proxy);
        axiosInstance.defaults.headers.common['Authorization'] = `Bearer ${token}`;
        
        try {
            const response = await axiosInstance.get(url);
            if (response.status === 200) {
                const { pin_points, coins, current_model, data_power } = response.data;

                this.log(`Model Hiện tại: ${current_model.name} | Lv: ${current_model.current_level} | Power: ${data_power}`);
                this.log(`Balance: ${pin_points}`, 'success');

                const coinToCollect = coins.find(c => c.type === "Telegram");
                if (coinToCollect && coinToCollect.count > 0) {
                    await this.collectCoins(token, coinToCollect, proxy);
                }

                if (hoinangcap) {
                    await this.checkAndUpgradeModel(token, pin_points, current_model.current_level, proxy);
                }
            }
        } catch (error) {
            this.log(`Home API error: ${error.message}`, 'error');
        }
    }

    parsePoints(points) {
        if (typeof points === 'number') return points;
        
        const multipliers = {
            'K': 1000,
            'M': 1000000
        };

        let numericValue = points.replace(/[,]/g, '');
        
        for (const [suffix, multiplier] of Object.entries(multipliers)) {
            if (points.includes(suffix)) {
                numericValue = parseFloat(points.replace(suffix, '')) * multiplier;
                break;
            }
        }

        return parseFloat(numericValue);
    }

    async checkAndUpgradeModel(token, currentPoints, currentLevel, proxy) {
        const url = "https://prod-api.pinai.tech/model/list";
        const axiosInstance = this.createAxiosInstance(proxy);
        axiosInstance.defaults.headers.common['Authorization'] = `Bearer ${token}`;

        try {
            const response = await axiosInstance.get(url);
            if (response.status === 200) {
                const { cost_config } = response.data;
                const nextLevelCost = cost_config.find(config => config.level === currentLevel + 1);
                
                if (nextLevelCost) {
                    const numericPoints = this.parsePoints(currentPoints);
                    
                    if (numericPoints >= nextLevelCost.cost) {
                        await this.upgradeModel(token, currentLevel + 1, proxy);
                    } else {
                        this.log(`Số dư không đủ để nâng cấp model lên level ${currentLevel + 1}. Cần ${nextLevelCost.cost_display} points`, 'warning');
                    }
                }
            }
        } catch (error) {
            this.log(`Không lấy được thông tin nâng cấp: ${error.message}`, 'error');
        }
    }

    async upgradeModel(token, newLevel, proxy) {
        const url = "https://prod-api.pinai.tech/model/upgrade";
        const axiosInstance = this.createAxiosInstance(proxy);
        axiosInstance.defaults.headers.common['Authorization'] = `Bearer ${token}`;

        try {
            const response = await axiosInstance.post(url, {});
            if (response.status === 200) {
                this.log(`Nâng cấp model thành công lên cấp ${newLevel}`, 'success');
            }
        } catch (error) {
            this.log(`Lỗi nâng cấp model: ${error.message}`, 'error');
        }
    }

    async collectCoins(token, coin, proxy) {
        const url = "https://prod-api.pinai.tech/home/collect";
        const axiosInstance = this.createAxiosInstance(proxy);
        axiosInstance.defaults.headers.common['Authorization'] = `Bearer ${token}`;
        const payload = [{ type: coin.type, count: coin.count }];

        try {
            while (coin.count > 0) {
                const response = await axiosInstance.post(url, payload);
                if (response.status === 200) {
                    coin.count = response.data.coins.find(c => c.type === "Telegram").count;
                    this.log(`Thu thập thành công, còn lại:: ${coin.count}`, 'success');

                    if (coin.count === 0) break;
                    await new Promise(resolve => setTimeout(resolve, 2000));
                } else {
                    this.log(`Lỗi thu thập: ${response.statusText}`, 'error');
                    break;
                }
            }
            this.log("Tất cả coin đã được thu thập.", 'success');
        } catch (error) {
            this.log(`Lỗi rồi: ${error.message}`, 'error');
        }
    }

    async getTasks(token, proxy) {
        const url = "https://prod-api.pinai.tech/task/list";
        const axiosInstance = this.createAxiosInstance(proxy);
        axiosInstance.defaults.headers.common['Authorization'] = `Bearer ${token}`;
        
        try {
            const response = await axiosInstance.get(url);
            if (response.status === 200) {
                const { tasks } = response.data;

                for (const task of tasks) {
                    if (task.task_id === 1001 && task.checkin_detail.is_today_checkin === 0) {
                        await this.completeTask(token, task.task_id, "Điểm danh hàng ngày thành công", proxy);
                    } else if (task.is_complete === false) {
                        await this.completeTask(token, task.task_id, `Nhiệm vụ ${task.task_name} hoàn thành | Phần thưởng: ${task.reward_points}`, proxy);
                    }
                }
            }
        } catch (error) {
            this.log(`Không thể lấy danh sách nhiệm vụ: ${error.message}`, 'error');
        }
    }

    async completeTask(token, taskId, successMessage, proxy) {
        const url = `https://prod-api.pinai.tech/task/${taskId}/complete`;
        const axiosInstance = this.createAxiosInstance(proxy);
        axiosInstance.defaults.headers.common['Authorization'] = `Bearer ${token}`;
        
        try {
            const response = await axiosInstance.post(url, {});
            if (response.status === 200 && response.data.status === "success") {
                this.log(successMessage, 'success');
            } else {
                this.log(`Không thể hoàn thành nhiệm vụ ${taskId}: ${response.statusText}`, 'error');
            }
        } catch (error) {
            this.log(`Lỗi làm nhiệm vụ ${taskId}: ${error.message}`, 'error');
        }
    }

    async processAccount() {
        try {
            this.proxyIP = await this.checkProxyIP(this.proxy);
            
            const userData = JSON.parse(decodeURIComponent(this.accountData.split('user=')[1].split('&')[0]));
            const userId = userData.id;
            
            const tokenData = fs.existsSync(this.tokenFilePath) ? 
                JSON.parse(fs.readFileSync(this.tokenFilePath, 'utf8')) : {};

            if (!tokenData[userId] || this.isExpired(tokenData[userId].access_token)) {
                this.log(`Token đã hết hạn ${userId}. Đăng nhập lại...`, 'warning');
                const newToken = await this.loginToPinaiAPI(this.accountData, this.proxy);
                if (newToken) {
                    this.saveAccessToken(userId, newToken);
                    await this.getHomeData(newToken, true, this.proxy);
                    await this.getTasks(newToken, this.proxy);
                }
            } else {
                this.log(`Token dùng được cho tài khoản ${userId}`, 'success');
                await this.getHomeData(tokenData[userId].access_token, true, this.proxy);
                await this.getTasks(tokenData[userId].access_token, this.proxy);
            }
        } catch (error) {
            await this.log(`Lỗi xử lý tài khoản: ${error.message}`, 'error');
        }
    }
}

class PinaiManager {
    constructor() {
        this.maxThreads = 10;
        this.accountTimeout = 600000; // 10 minutes
        this.restPeriod = 3000000; // 50 minutes
        this.data = this.loadData();
        this.proxyList = this.loadProxies();
    }

    loadData() {
        const dataFile = path.join(__dirname, 'data.txt');
        return fs.readFileSync(dataFile, 'utf8')
            .replace(/\r/g, '')
            .split('\n')
            .filter(Boolean);
    }

    loadProxies() {
        try {
            const proxyFile = path.join(__dirname, 'proxy.txt');
            return fs.readFileSync(proxyFile, 'utf8')
                .replace(/\r/g, '')
                .split('\n')
                .filter(Boolean);
        } catch (error) {
            console.log(`Lỗi đọc file proxy: ${error.message}`.red);
            return [];
        }
    }

    async processAccountBatch(accounts) {
        const workers = accounts.map((account, index) => {
            return new Promise((resolve, reject) => {
                const worker = new Worker(__filename, {
                    workerData: {
                        accountData: account,
                        proxy: this.proxyList[index % this.proxyList.length],
                        accountIndex: index
                    }
                });

                const timeout = setTimeout(() => {
                    worker.terminate();
                    reject(new Error('Worker timeout'));
                }, this.accountTimeout);

                worker.on('message', (result) => {
                    clearTimeout(timeout);
                    resolve(result);
                });

                worker.on('error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });

                worker.on('exit', (code) => {
                    clearTimeout(timeout);
                    if (code !== 0) {
                        reject(new Error(`Luồng bị dừng với mã ${code}`));
                    }
                });
            });
        });

        return Promise.allSettled(workers);
    }

    async countdown(seconds) {
        for (let i = seconds; i > 0; i--) {
            const timestamp = new Date().toLocaleTimeString();
            readline.cursorTo(process.stdout, 0);
            process.stdout.write(`[${timestamp}] Chờ ${i} giây cho chu kỳ tiếp theo...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
    }

    async start() {
        console.log('='.repeat(50));
        console.log('Tool được chia sẻ tại kênh telegram Dân Cày Airdrop (@dancayairdrop)'.green);
        console.log(`Chạy ${this.maxThreads} tài khoản đồng thời`.cyan);
        console.log(`Account timeout: ${this.accountTimeout / 1000} seconds`.cyan);
        console.log(`Thời gian nghỉ ngơi: ${this.restPeriod / 1000} seconds`.cyan);
        console.log('='.repeat(50));

        while (true) {
            try {
                for (let i = 0; i < this.data.length; i += this.maxThreads) {
                    console.log(`\nĐang chạy luồng ${Math.floor(i / this.maxThreads) + 1}/${Math.ceil(this.data.length / this.maxThreads)}`.yellow);
                    
                    const batch = this.data.slice(i, i + this.maxThreads);
                    const results = await this.processAccountBatch(batch);
                    
                    results.forEach((result, index) => {
                        if (result.status === 'rejected') {
                            console.log(`Account ${i + index + 1} failed: ${result.reason.message}`.red);
                        }
                    });
                }

                console.log('\nTất cả các tài khoản được xử lý. Bắt đầu thời gian nghỉ ngơi...'.green);
                await this.countdown(this.restPeriod / 1000);
            } catch (error) {
                console.log(`Error in main loop: ${error.message}`.red);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }
}

if (isMainThread) {
    const manager = new PinaiManager();
    manager.start().catch(error => {
        console.error(`Fatal error: ${error.message}`.red);
        process.exit(1);
    });
} else {
    const worker = new PinaiWorker(
        workerData.accountData,
        workerData.proxy,
        workerData.accountIndex
    );
    worker.processAccount()
        .then(() => parentPort.postMessage('done'))
        .catch(error => parentPort.postMessage({ error: error.message }));
}