const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const http = require('http');

// 启用 stealth 插件
chromium.use(stealth);

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const USER_DATA_DIR = path.join(__dirname, 'ChromeData_Katabump');
const DEBUG_PORT = 9222;
const HEADLESS = false;
// const HTTP_PROXY = ""
// --- Proxy Configuration ---
const HTTP_PROXY = process.env.HTTP_PROXY; // e.g., http://user:pass@1.2.3.4:8080 or http://1.2.3.4:8080
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[Proxy] Configuration detected: Server=${PROXY_CONFIG.server}, Auth=${PROXY_CONFIG.username ? 'Yes' : 'No'}`);
    } catch (e) {
        console.error('[Proxy] Invalid HTTP_PROXY format. Expected: http://user:pass@host:port or http://host:port');
        process.exit(1);
    }
}


// --- injected.js 核心逻辑 ---
// 这个脚本会被注入到每个 Frame 中。它劫持 attachShadow 以捕获 Turnstile 的 checkbox，
// 计算其相对于 Frame 视口的位置比例，并存入 window.__turnstile_data 供外部读取。
const INJECTED_SCRIPT = `
(function() {
    // 只在 iframe 中运行（Turnstile 通常在 iframe 里）
    if (window.self === window.top) return;

    // 1. 模拟鼠标屏幕坐标 (尝试保留这个优化)
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { 
        // 忽略错误，如果不允许修改也没关系，不影响主流程
    }

    // 2. 简单的 attachShadow Hook (回退到这个版本，确保能找到元素)
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            
            if (shadowRoot) {
                const checkAndReport = () => {
                    // 尝试在 Shadow Root 中查找 checkbox
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        // 确保元素已渲染且可见
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            
                            // 暴露数据给 Playwright
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };

                // 立即检查一次
                if (!checkAndReport()) {
                    // 如果没找到，监听 DOM 变化
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[Injected] Error hooking attachShadow:', e);
    }
})();
`;

// 辅助函数：检测代理是否可用
async function checkProxy() {
    if (!PROXY_CONFIG) return true;

    console.log('[Proxy] Validating proxy connection...');
    try {
        const axiosConfig = {
            proxy: {
                protocol: 'http',
                host: new URL(PROXY_CONFIG.server).hostname,
                port: new URL(PROXY_CONFIG.server).port,
            },
            timeout: 10000
        };

        if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
            axiosConfig.proxy.auth = {
                username: PROXY_CONFIG.username,
                password: PROXY_CONFIG.password
            };
        }

        // 尝试访问一个可靠的测试地址 (Cloudflare Trace 或者 Google)
        await axios.get('https://www.google.com', axiosConfig);
        console.log('[Proxy] Connection successful!');
        return true;
    } catch (error) {
        console.error(`[Proxy] Connection failed: ${error.message}`);
        return false;
    }
}

// 辅助函数：检测端口是否开放
function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => {
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

// 辅助函数：启动原生 Chrome
async function launchNativeChrome() {
    console.log('Checking if Chrome is already running on port ' + DEBUG_PORT + '...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome is already open.');
        return;
    }

    console.log('Launching native Chrome...');
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${USER_DATA_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
    ];

    if (PROXY_CONFIG) {
        // Chrome 命令行只接受 server 地址，认证需要在 playright 层或者插件层处理
        // 这里我们要 strip 掉 username:password
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        // 确保 Chrome 自身请求 localhost (如 CDP) 不走代理
        args.push('--proxy-bypass-list=<-loopback>');
    }

    if (HEADLESS) {
        args.push('--headless=new');
    }

    const chrome = spawn(CHROME_PATH, args, {
        detached: true,
        stdio: 'ignore'
    });
    chrome.unref();

    console.log('Waiting for Chrome to initialize...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!await checkPort(DEBUG_PORT)) {
        console.error('Chrome failed to start on port ' + DEBUG_PORT);
        if (!checkPort(DEBUG_PORT)) {
            try { chrome.kill(); } catch (e) { }
        }
        throw new Error('Chrome launch failed');
    }
}

// 从 login.json 读取用户列表
function getUsers() {
    try {
        const data = fs.readFileSync(path.join(__dirname, 'login.json'), 'utf8');
        const json = JSON.parse(data);
        return Array.isArray(json) ? json : (json.users || []);
    } catch (e) {
        console.error('Error reading login.json:', e);
        return [];
    }
}

/**
 * 核心功能：遍历所有 Frames，查找被注入脚本标记的 Turnstile 坐标，
 * 计算绝对屏幕坐标，并使用 CDP 发送原生鼠标点击事件。
 */
async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            // 检查当前 Frame 是否捕获到了 Turnstile 数据
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);

            if (data) {
                console.log('>> Found Turnstile in frame. Ratios:', data);

                // 获取 iframe 元素在主页面中的位置
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;

                const box = await iframeElement.boundingBox();
                if (!box) continue;

                // 计算绝对坐标：iframe 左上角 + (iframe 宽/高 * 比例)
                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);

                console.log(`>> Calculated absolute click coordinates: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);

                // 创建 CDP 会话并发送点击命令
                const client = await page.context().newCDPSession(page);

                // 1. Mouse Pressed
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1
                });

                // 模拟人类点击持续时间 (50ms - 150ms)
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));

                // 2. Mouse Released
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1
                });

                console.log('>> CDP Click sent successfully.');
                await client.detach();
                return true; // 成功点击
            }
        } catch (e) {
            // 忽略 Frame 访问错误（跨域等）
        }
    }
    return false;
}

// ==========================================
// ========== ALTCHA专区 (Renew用) ==========
// ==========================================
async function getAltchaStatus(page) {
    try {
        return await page.evaluate(() => {
            const normalize = (value) => {
                if (value == null) return '';
                return String(value).trim();
            };

            const widget = document.querySelector('altcha-widget');
            const altchaInputs = Array.from(document.querySelectorAll('input[name="altcha"], textarea[name="altcha"], input[name*="altcha" i], textarea[name*="altcha" i]'));
            const firstFilledInput = altchaInputs.find((input) => normalize(input.value).length > 0);
            const shadowRoot = widget ? widget.shadowRoot : null;
            const checkbox = shadowRoot ? shadowRoot.querySelector('input[type="checkbox"], [role="checkbox"]') : null;

            const stateProp = normalize(widget ? widget.state : '');
            const stateAttr = normalize(widget ? widget.getAttribute('state') : '');
            const valueProp = normalize(widget ? widget.value : '');
            const valueAttr = normalize(widget ? widget.getAttribute('value') : '');
            const hiddenInputValue = normalize(firstFilledInput ? firstFilledInput.value : '');
            const checkboxChecked = checkbox && typeof checkbox.checked === 'boolean' ? checkbox.checked : null;
            const ariaChecked = normalize(checkbox ? checkbox.getAttribute('aria-checked') : '');
            const busyAttr = normalize(widget ? widget.getAttribute('aria-busy') : '');
            const state = stateProp || stateAttr || '';
            const isSolved = state === 'verified' || valueProp.length > 0 || valueAttr.length > 0 || hiddenInputValue.length > 0;
            const isVerifying = !isSolved && (
                state === 'verifying' ||
                state === 'processing' ||
                state === 'working' ||
                checkboxChecked === true ||
                ariaChecked === 'true' ||
                busyAttr === 'true'
            );

            return {
                exists: !!widget || altchaInputs.length > 0,
                solved: isSolved,
                isVerifying,
                state: state || 'unknown',
                hasShadowRoot: !!shadowRoot,
                checkboxChecked,
                ariaChecked,
                valueLength: Math.max(valueProp.length, valueAttr.length),
                hiddenInputLength: hiddenInputValue.length,
                busy: busyAttr === 'true'
            };
        });
    } catch (e) {
        return {
            exists: false,
            solved: false,
            isVerifying: false,
            state: 'error',
            hasShadowRoot: false,
            checkboxChecked: null,
            ariaChecked: '',
            valueLength: 0,
            hiddenInputLength: 0,
            busy: false
        };
    }
}

function formatAltchaStatus(status) {
    const checkedText = status.checkboxChecked === null ? 'unknown' : String(status.checkboxChecked);
    const ariaChecked = status.ariaChecked || 'n/a';
    return `state=${status.state}, solved=${status.solved}, verifying=${status.isVerifying}, shadow=${status.hasShadowRoot}, checked=${checkedText}, ariaChecked=${ariaChecked}, valueLen=${status.valueLength}, hiddenLen=${status.hiddenInputLength}, busy=${status.busy}`;
}

async function checkAltchaSuccess(page) {
    const status = await getAltchaStatus(page);
    return status.solved;
}

async function attemptAltchaClick(page, currentStatus = null) {
    try {
        const altchaWidget = page.locator('altcha-widget').first();
        if (await altchaWidget.count() > 0) {
            const status = currentStatus || await getAltchaStatus(page);
            if (status.solved) return false;
            if (status.isVerifying) {
                console.log(`>> ALTCHA 正在验证中，跳过重复点击。${formatAltchaStatus(status)}`);
                return false;
            }

            const shadowCheckbox = altchaWidget.locator('input[type="checkbox"], [role="checkbox"]').first();
            if (await shadowCheckbox.count() > 0) {
                try {
                    await shadowCheckbox.click({ force: true, timeout: 1500 });
                    console.log('>> 已尝试点击 ALTCHA shadowRoot checkbox');
                    return true;
                } catch (e) {}
            }

            const box = await altchaWidget.boundingBox();
            if (box) {
                const clickX = box.x + Math.min(24, Math.max(12, box.width * 0.1));
                const clickY = box.y + box.height / 2;
                await page.mouse.click(clickX, clickY);
                console.log(`>> 已根据 altcha-widget 坐标派发点击: (${clickX.toFixed(1)}, ${clickY.toFixed(1)})`);
                return true;
            }
        }
    } catch (e) {
        console.log('>> ALTCHA 点击尝试出错:', e.message);
    }
    return false;
}

async function solveAltchaIfPresent(page, stageName = "Renew阶段", maxAttempts = 15, waitAfterClick = 8000) {
    const startedAt = Date.now();
    const totalWaitBudget = maxAttempts * waitAfterClick;
    let sawAltcha = false;

    while (Date.now() - startedAt < totalWaitBudget) {
        const status = await getAltchaStatus(page);
        if (status.exists) sawAltcha = true;
        if (!status.exists) return true;
        if (status.solved) {
            console.log(`[${stageName}] ALTCHA 验证已完成。${formatAltchaStatus(status)}`);
            return true;
        }

        if (status.isVerifying) {
            console.log(`[${stageName}] ALTCHA 正在计算/验证中... ${formatAltchaStatus(status)}`);
            await page.waitForTimeout(1000);
            continue;
        }

        console.log(`[${stageName}] 尝试点击 ALTCHA... ${formatAltchaStatus(status)}`);
        const clicked = await attemptAltchaClick(page, status);
        if (!clicked) {
            await page.waitForTimeout(1000);
            continue;
        }

        const clickStartedAt = Date.now();
        let observedVerification = false;

        while (Date.now() - clickStartedAt < waitAfterClick) {
            await page.waitForTimeout(1000);
            const followupStatus = await getAltchaStatus(page);

            if (followupStatus.solved) {
                console.log(`[${stageName}] ALTCHA 验证成功！${formatAltchaStatus(followupStatus)}`);
                return true;
            }

            if (followupStatus.isVerifying) {
                observedVerification = true;
                continue;
            }

            if (!observedVerification && Date.now() - clickStartedAt >= 2500) {
                console.log(`[${stageName}] ⚠️ 点击后未观察到 ALTCHA 进入 verifying 状态，准备重新尝试点击...`);
                break;
            }
        }
    }

    if (!sawAltcha) {
        console.log(`[${stageName}] 弹窗中未检测到 ALTCHA 组件。`);
        return true;
    }

    const finalStatus = await getAltchaStatus(page);
    console.log(`[${stageName}] 检测到 ALTCHA，但在 ${Math.ceil((Date.now() - startedAt) / 1000)} 秒内未能通过验证。最终状态: ${formatAltchaStatus(finalStatus)}`);
    return false;
}

async function getServerIds(page) {
    console.log('正在获取服务器列表...');
    await page.waitForSelector('.table tbody tr, .table, a[href*="/servers/edit"]', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);

    let serverIds = [];
    // 方式 1: 直接读取内部 API
    try {
        const apiData = await page.evaluate(async () => {
            try {
                const res = await fetch("/api-client/list-servers", { method: "GET" });
                if (res.ok) return await res.json();
            } catch (e) {}
            return null;
        });
        if (Array.isArray(apiData) && apiData.length > 0) {
            serverIds = apiData.map(s => String(s.id)).filter(Boolean);
            console.log(`>> 通过内部 API 成功获取到 ${serverIds.length} 个服务器: ${serverIds.join(', ')}`);
        }
    } catch (e) {}

    // 方式 2: 解析 DOM 中的 /servers/edit?id= 链接
    if (serverIds.length === 0) {
        try {
            const links = await page.locator('a[href*="/servers/edit"]').all();
            for (const l of links) {
                const href = await l.getAttribute('href');
                if (href) {
                    const match = href.match(/id=(\d+)/);
                    if (match && !serverIds.includes(match[1])) {
                        serverIds.push(match[1]);
                    }
                }
            }
            if (serverIds.length > 0) {
                console.log(`>> 通过 DOM 链接成功获取到 ${serverIds.length} 个服务器: ${serverIds.join(', ')}`);
            }
        } catch (e) {}
    }

    // 方式 3: 兼容旧版 "See" 按钮
    if (serverIds.length === 0) {
        try {
            const seeLink = page.getByRole('link', { name: /see|voir|查看/i }).first();
            if (await seeLink.isVisible({ timeout: 3000 })) {
                const href = await seeLink.getAttribute('href');
                const match = href ? href.match(/id=(\d+)/) : null;
                if (match) {
                    serverIds.push(match[1]);
                }
            }
        } catch (e) {}
    }

    return serverIds;
}


(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('No users found in login.json');
        return;
    }

    // 检查代理有效性
    if (PROXY_CONFIG) {
        const isValid = await checkProxy();
        if (!isValid) {
            console.error('[Proxy] Aborting due to invalid proxy.');
            process.exit(1);
        }
    }

    await launchNativeChrome();

    console.log(`Connecting to Chrome instance...`);
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('Successfully connected!');
            break;
        } catch (e) {
            console.log(`Connection attempt ${k + 1} failed. Retrying in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (!browser) {
        console.error('Failed to connect. Exiting.');
        return;
    }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    // --- 代理认证处理 ---
    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        console.log('[Proxy] Setting up authentication...');
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    } else {
        // 如果没有代理(或者代理无认证)，清除之前的认证信息，防止干扰
        await context.setHTTPCredentials(null);
    }

    // --- 关键：注入 Hook 脚本 ---
    // 这会在每次页面加载/导航前执行，确保能拦截到 Turnstile 的创建
    await page.addInitScript(INJECTED_SCRIPT);
    console.log('Injection script added to page context.');

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== Processing User ${i + 1}/${users.length}: ${user.username} ===`);

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                // Context credentials should persist, no need to re-auth per page
                await page.addInitScript(INJECTED_SCRIPT); // 新页面也要注入
            }

            // 登录逻辑保持不变...
            console.log('Checking session state...');
            if (page.url().includes('/auth/login')) {
                // Already on login logic
            } else if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
            } else {
                await page.goto('https://dashboard.katabump.com/auth/login');
                await page.waitForTimeout(2000);
                if (page.url().includes('dashboard')) {
                    await page.goto('https://dashboard.katabump.com/auth/logout');
                    await page.waitForTimeout(2000);
                    await page.goto('https://dashboard.katabump.com/auth/login');
                }
            }

            console.log('Filling credentials...');
            try {
                const emailInput = page.getByRole('textbox', { name: 'Email' });
                await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                await emailInput.fill(user.username);
                const pwdInput = page.getByRole('textbox', { name: 'Password' });
                await pwdInput.fill(user.password);
                await page.waitForTimeout(500);

                // --- Cloudflare Turnstile Bypass for Login ---
                console.log('   >> Checking for Turnstile before login (using CDP bypass)...');
                let cdpClickResult = false;
                for (let findAttempt = 0; findAttempt < 15; findAttempt++) {
                    cdpClickResult = await attemptTurnstileCdp(page);
                    if (cdpClickResult) break;
                    // console.log(`   >> [Login Find Attempt ${findAttempt + 1}/15] Turnstile checkbox not found yet...`);
                    await page.waitForTimeout(1000);
                }

                if (cdpClickResult) {
                    console.log('   >> CDP Click active for login. Waiting up to 10s for Cloudflare success...');
                    // Wait for the "Success!" mark in any cloudflare frame
                    for (let waitSec = 0; waitSec < 10; waitSec++) {
                        const frames = page.frames();
                        let isSuccess = false;
                        for (const f of frames) {
                            if (f.url().includes('cloudflare')) {
                                try {
                                    if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) {
                                        isSuccess = true;
                                        break;
                                    }
                                } catch (e) { }
                            }
                        }
                        if (isSuccess) {
                            console.log('   >> Turnstile verification successful before login.');
                            break;
                        }
                        await page.waitForTimeout(1000);
                    }
                } else {
                    console.log('   >> No Turnstile detected or clicked before login, proceeding anyway...');
                }
                // --------------------------------------------

                await page.getByRole('button', { name: 'Login', exact: true }).click();

                // User Request: Check for "Incorrect password or no account"
                try {
                    const errorMsg = page.getByText('Incorrect password or no account');
                    if (await errorMsg.isVisible({ timeout: 3000 })) {
                        console.error(`   >> ❌ Login failed: Incorrect password or no account for user ${user.username}`);

                        // Screenshot for login failure
                        const photoDir = path.join(__dirname, 'photo');
                        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                        try { await page.screenshot({ path: path.join(photoDir, `${user.username}.png`), fullPage: true }); } catch (e) { }

                        // Skip to next user
                        continue;
                    }
                } catch (e) { }

            } catch (e) {
                // 可能已经登录了，或者是其他 UI 状态
                console.log('Login form interaction error (maybe already logged in?):', e.message);
            }

            const serverIds = await getServerIds(page);
            if (serverIds.length === 0) {
                console.log('Could not find any servers (list might be empty or loading timed out).');
                continue;
            }

            for (let sIdx = 0; sIdx < serverIds.length; sIdx++) {
                const serverId = serverIds[sIdx];
                console.log(`\n=== Processing User ${user.username} Server [${sIdx + 1}/${serverIds.length}] ID: ${serverId} ===`);
                await page.goto(`https://dashboard.katabump.com/servers/edit?id=${serverId}`);
                await page.waitForTimeout(2000);

                let renewSuccess = false;
                for (let attempt = 1; attempt <= 20; attempt++) {
                    let hasCaptchaError = false;

                    console.log(`\n[Attempt ${attempt}/20] Looking for Renew button...`);
                    const renewBtn = page.locator('button[data-bs-target="#renew-modal"], button:has-text("Renew"), .btn-outline-primary').first();
                    try {
                        await renewBtn.waitFor({ state: 'visible', timeout: 5000 });
                    } catch (e) { }
                    if (await renewBtn.isVisible()) {
                        await renewBtn.click();
                        console.log('Renew button clicked. Waiting for modal...');

                        const modal = page.locator('#renew-modal');
                        try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {
                            console.log('Modal did not appear? Retrying...');
                            continue;
                        }

                        try {
                            const box = await modal.boundingBox();
                            if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                        } catch (e) { }

                        console.log('Checking for Turnstile (using CDP bypass)...');
                        let cdpClickResult = false;
                        for (let findAttempt = 0; findAttempt < 30; findAttempt++) {
                            cdpClickResult = await attemptTurnstileCdp(page);
                            if (cdpClickResult) break;
                            await page.waitForTimeout(1000);
                        }

                        let isTurnstileSuccess = false;
                        if (cdpClickResult) {
                            console.log('   >> CDP Click active. Waiting 8s for Cloudflare check...');
                            await page.waitForTimeout(8000);
                        } else {
                            console.log('   >> Turnstile checkbox not confirmed after retries.');
                        }

                        const frames = page.frames();
                        for (const f of frames) {
                            if (f.url().includes('cloudflare')) {
                                try {
                                    if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) {
                                        console.log('   >> Detected "Success!" in Turnstile iframe.');
                                        isTurnstileSuccess = true;
                                        break;
                                    }
                                } catch (e) { }
                            }
                        }

                        // ALTCHA Captcha Handling
                        const altchaOk = await solveAltchaIfPresent(page, "Renew Modal", 15, 8000);
                        if (!altchaOk) {
                            console.log('   >> ALTCHA not passed, refreshing to retry...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            if (page.url().includes('login')) {
                                console.log('   >> Redirected to login page after reload.');
                                break;
                            }
                            continue;
                        }

                        const confirmBtn = modal.locator('button[type="submit"], button:has-text("Renew"), .btn-primary').first();
                        if (await confirmBtn.isVisible()) {
                            const photoDir = path.join(__dirname, 'photo');
                            if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                            const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
                            const tsScreenshotName = `${safeUser}_Turnstile_${serverId}_${attempt}.png`;
                            try {
                                await page.screenshot({ path: path.join(photoDir, tsScreenshotName), fullPage: true });
                                console.log(`   >> 📸 Snapshot saved: ${tsScreenshotName}`);
                            } catch (e) { }

                            console.log('   >> Clicking Renew confirm button...');
                            await confirmBtn.click();

                            try {
                                const startVerifyTime = Date.now();
                                while (Date.now() - startVerifyTime < 3000) {
                                    if (await page.getByText('Please complete the captcha to continue').isVisible()) {
                                        console.log('   >> ⚠️ Error detected: "Please complete the captcha".');
                                        hasCaptchaError = true;
                                        break;
                                    }

                                    const notTimeLoc = page.getByText("You can't renew your server yet");
                                    if (await notTimeLoc.isVisible()) {
                                        const text = await notTimeLoc.innerText();
                                        const match = text.match(/as of\s+(.*?)\s+\(/);
                                        let dateStr = match ? match[1] : 'Unknown Date';
                                        console.log(`   >> ⏳ Cannot renew yet. Next renewal available as of: ${dateStr}`);
                                        renewSuccess = true;
                                        try {
                                            const closeBtn = modal.getByLabel('Close');
                                            if (await closeBtn.isVisible()) await closeBtn.click();
                                        } catch (e) { }
                                        break;
                                    }
                                    await page.waitForTimeout(200);
                                }
                            } catch (e) { }

                            if (renewSuccess) break;

                            if (hasCaptchaError) {
                                console.log('   >> Error found. Refreshing page to reset Turnstile...');
                                await page.reload();
                                await page.waitForTimeout(3000);
                                continue;
                            }

                            await page.waitForTimeout(2000);
                            if (!await modal.isVisible()) {
                                console.log(`   >> ✅ Modal closed. Server ${serverId} renewed successfully!`);
                                renewSuccess = true;
                                break;
                            } else {
                                console.log('   >> Modal still open. Refreshing to retry...');
                                await page.reload();
                                await page.waitForTimeout(3000);
                                continue;
                            }
                        } else {
                            console.log('   >> Verify button inside modal not found? Refreshing...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }
                    } else {
                        console.log(`Renew button not found for server ${serverId} (might be already renewed).`);
                        break;
                    }
                }
            }

        } catch (err) {
            console.error(`Error processing user ${user.username}:`, err);
        }

        // Snapshot before handling next user (Normal end of loop)
        const photoDir = path.join(__dirname, 'photo');
        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
        const screenshotPath = path.join(photoDir, `${user.username}.png`);
        try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
            console.log(`Saved screenshot to: ${screenshotPath}`);
        } catch (e) {
            console.log('Failed to take screenshot:', e.message);
        }

        console.log(`Finished User ${user.username}\n`);
    }

    console.log('All users processed.');
    console.log('Closing browser connection.');
    await browser.close();
})();
