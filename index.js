import "dotenv/config";
import blessed from "blessed";
import figlet from "figlet";
import { ethers } from "ethers";

// Cấu hình biến môi trường
const RPC_URL = process.env.RPC_URL || "https://your-default-rpc-url";
const PRIVATE_KEYS_RAW = process.env.PRIVATE_KEYS || "";
if (!PRIVATE_KEYS_RAW) {
  console.error("Lỗi: Không tìm thấy PRIVATE_KEYS trong .env");
  process.exit(1);
}
const PRIVATE_KEYS = PRIVATE_KEYS_RAW.split(",").map(key => {
  key = key.trim();
  if (!key.startsWith("0x") && key.match(/^[0-9a-fA-F]{64}$/)) {
    return "0x" + key;
  }
  return key;
}).filter(key => key);

const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS || "0xYourRouterAddress";
const USDT_ADDRESS = process.env.USDT_ADDRESS || "0xYourUSDTAddress";
const ETH_ADDRESS = process.env.ETH_ADDRESS || "0xYourETHAddress";
const BTC_ADDRESS = process.env.BTC_ADDRESS || "0xYourBTCAddress";
const AOGI_ADDRESS = process.env.AOGI_ADDRESS || "0xYourAOGIAddress";
const NETWORK_NAME = process.env.NETWORK_NAME || "Unknown Network";
const APPROVAL_GAS_LIMIT = 100000;
const SWAP_GAS_LIMIT = 150000;
const ESTIMATED_GAS_USAGE = 150000;

const provider = new ethers.JsonRpcProvider(RPC_URL);

// Khởi tạo wallets
const wallets = PRIVATE_KEYS.map((key, index) => {
  try {
    if (!key.match(/^0x[0-9a-fA-F]{64}$/)) {
      throw new Error(`Private key ${index + 1} không đúng định dạng (64 ký tự hex với 0x)`);
    }
    const wallet = new ethers.Wallet(key, provider);
    console.log(`Ví ${index + 1} được tạo: ${wallet.address}`);
    return wallet;
  } catch (error) {
    console.error(`Lỗi với private key ${index + 1}: ${error.message}`);
    process.exit(1);
  }
});
console.log(`Tổng cộng ${wallets.length} ví đã được khởi tạo.`);

// ABI definitions
const CONTRACT_ABI = [
  {
    inputs: [
      {
        components: [
          { internalType: "address", name: "tokenIn", type: "address" },
          { internalType: "address", name: "tokenOut", type: "address" },
          { internalType: "uint24", name: "fee", type: "uint24" },
          { internalType: "address", name: "recipient", type: "address" },
          { internalType: "uint256", name: "deadline", type: "uint256" },
          { internalType: "uint256", name: "amountIn", type: "uint256" },
          { internalType: "uint256", name: "amountOutMinimum", type: "uint256" },
          { internalType: "uint160", name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        internalType: "struct ISwapRouter.ExactInputSingleParams",
        name: "params",
        type: "tuple",
      },
    ],
    name: "exactInputSingle",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
];

const USDT_ABI = [
  { constant: false, inputs: [{ name: "_spender", type: "address" }, { name: "_value", type: "uint256" }], name: "approve", outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { constant: true, inputs: [{ name: "_owner", type: "address" }], name: "balanceOf", outputs: [{ name: "balance", type: "uint256" }], stateMutability: "view", type: "function" },
  { constant: true, inputs: [{ name: "_owner", type: "address" }, { name: "_spender", type: "address" }], name: "allowance", outputs: [{ name: "remaining", type: "uint256" }], stateMutability: "view", type: "function" }
];

const ETH_ABI = USDT_ABI;
const BTC_ABI = USDT_ABI;

let transactionRunning = false;
let chosenSwap = null;
let transactionQueue = Promise.resolve();
let transactionQueueList = [];
let transactionIdCounter = 0;
let nextNonces = wallets.map(() => null);
let selectedGasPrice = null;

// Khai báo UI elements ở phạm vi toàn cục
const screen = blessed.screen({ smartCSR: true, title: "LocalSec", fullUnicode: true, mouse: true });
const headerBox = blessed.box({ top: 0, left: "center", width: "100%", tags: true, style: { fg: "white" } });
const descriptionBox = blessed.box({ left: "center", width: "100%", content: "{center}{bold}{bright-yellow-fg}« ✮ 0̲̅G̲̅ L̲̅A̲̅B̲̅S̲̅ TỰ ĐỘNG HOÁN ĐỔI ✮ »{/bright-yellow-fg}{/bold}{/center}", tags: true });
const logsBox = blessed.box({ label: " Nhật Ký Giao Dịch ", border: { type: "line" }, top: 0, left: 0, width: "60%", height: 10, scrollable: true, alwaysScroll: true, mouse: true, keys: true, tags: true, scrollbar: { ch: " ", style: { bg: "blue" } }, style: { border: { fg: "red" }, fg: "bright-cyan" } });
const walletBox = blessed.box({ label: " Thông Tin Ví ", border: { type: "line" }, tags: true, style: { border: { fg: "magenta" }, fg: "white" }, content: "Đang lấy dữ liệu ví..." });
const gasPriceBox = blessed.box({ label: " Thông Tin Giá Gas ", tags: true, border: { type: "line" }, style: { border: { fg: "blue" }, fg: "white" }, content: "Đang tải giá gas..." });
const mainMenu = blessed.list({ label: " Menu ", left: "60%", keys: true, mouse: true, border: { type: "line" }, style: { fg: "white", border: { fg: "yellow" }, selected: { bg: "green", fg: "black" } }, items: [] });
const autoSwapSubMenu = blessed.list({ label: " Menu Hoán Đổi Tự Động ", left: "60%", keys: true, mouse: true, border: { type: "line" }, style: { selected: { bg: "blue", fg: "white" }, border: { fg: "yellow" }, fg: "white" }, items: [] });
const queueMenu = blessed.box({ label: " Hàng Đợi Giao Dịch ", top: "10%", left: "center", width: "80%", height: "80%", border: { type: "line" }, style: { border: { fg: "blue" } }, scrollable: true, keys: true, mouse: true, alwaysScroll: true, tags: true });
const exitButton = blessed.button({ content: " Thoát ", bottom: 0, left: "center", shrink: true, padding: { left: 1, right: 1 }, border: { type: "line" }, style: { fg: "white", bg: "red", border: { fg: "white" }, hover: { bg: "blue" } }, mouse: true, keys: true });
const promptBox = blessed.prompt({ parent: screen, border: "line", height: "20%", width: "50%", top: "center", left: "center", label: "{bright-blue-fg}Số Lượng Hoán Đổi{/bright-blue-fg}", tags: true, keys: true, mouse: true, style: { fg: "bright-white", border: { fg: "red" } } });

let transactionLogs = [];
let renderTimeout;

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function shortHash(hash) { return `${hash.substring(0, 6)}...${hash.substring(hash.length - 4)}`; }
async function interruptibleDelay(totalMs) {
  const interval = 200;
  let elapsed = 0;
  while (elapsed < totalMs) {
    if (!transactionRunning) break;
    await delay(interval);
    elapsed += interval;
  }
}

function safeRender() {
  if (renderTimeout) clearTimeout(renderTimeout);
  renderTimeout = setTimeout(() => { screen.render(); }, 50);
}

function updateLogs() {
  logsBox.setContent(transactionLogs.join("\n"));
  logsBox.scrollTo(logsBox.getScrollHeight());
  safeRender();
}

function addLog(message, type) {
  const timestamp = new Date().toLocaleTimeString('vi-VN');
  let coloredMessage = message;
  if (type === "system") coloredMessage = `{bright-white-fg}${message}{/bright-white-fg}`;
  else if (type === "0g") coloredMessage = `{bright-cyan-fg}${message}{/bright-cyan-fg}`;
  transactionLogs.push(`[ {bold}{grey-fg}${timestamp}{/grey-fg}{/bold} ] ${coloredMessage}`);
  updateLogs();
}

function clearTransactionLogs() {
  transactionLogs = [];
  updateLogs();
  addLog("Nhật ký giao dịch đã được xóa.", "system");
}

figlet.text("LocalSec", { font: "Speed" }, (err, data) => {
  headerBox.setContent(err ? "{center}{bold}LocalSec{/bold}{/center}" : `{center}{bold}{green-fg}${data}{/green-fg}{/bold}{/center}`);
  screen.render();
});

async function updateGasPriceBox() {
  try {
    const feeData = await provider.getFeeData();
    const gasPriceBN = feeData.gasPrice;
    const gasNormal = gasPriceBN;
    const gasRendah = gasPriceBN * 80n / 100n;
    const gasFeeX2 = gasPriceBN * 2n;
    const feeNormal = gasNormal * BigInt(ESTIMATED_GAS_USAGE);
    const feeRendah = gasRendah * BigInt(ESTIMATED_GAS_USAGE);
    const feeX2 = gasFeeX2 * BigInt(ESTIMATED_GAS_USAGE);
    const gasNormalStr = parseFloat(ethers.formatUnits(gasNormal, "gwei")).toFixed(3);
    const gasRendahStr = parseFloat(ethers.formatUnits(gasRendah, "gwei")).toFixed(3);
    const gasX2Str = parseFloat(ethers.formatUnits(gasFeeX2, "gwei")).toFixed(3);
    const feeNormalStr = parseFloat(ethers.formatEther(feeNormal)).toFixed(5);
    const feeRendahStr = parseFloat(ethers.formatEther(feeRendah)).toFixed(5);
    const feeX2Str = parseFloat(ethers.formatEther(feeX2)).toFixed(5);
    const content =
      ` Gas Bình Thường : {bright-green-fg}${gasNormalStr}{/bright-green-fg} Gwei      {bright-yellow-fg} ➥ {/bright-yellow-fg}     Phí Dự Kiến : {bright-red-fg}${feeNormalStr}{/bright-red-fg} AOGI\n` +
      ` Gas Thấp       : {bright-green-fg}${gasRendahStr}{/bright-green-fg} Gwei      {bright-yellow-fg} ➥ {/bright-yellow-fg}     Phí Dự Kiến : {bright-red-fg}${feeRendahStr}{/bright-red-fg} AOGI\n` +
      ` Gas Phí x2     : {bright-green-fg}${gasX2Str}{/bright-green-fg} Gwei     {bright-yellow-fg} ➥ {/bright-yellow-fg}     Phí Dự Kiến : {bright-red-fg}${feeX2Str}{/bright-red-fg} AOGI`;
    gasPriceBox.setContent(content);
    screen.render();
  } catch (error) {
    addLog("Không thể cập nhật giá gas: " + error.message, "error");
  }
}
setInterval(updateGasPriceBox, 10000);
updateGasPriceBox();

function updateMainMenuItems() {
  const baseItems = ["Hoán Đổi 0g", "Hàng Đợi Giao Dịch", "Xóa Nhật Ký Giao Dịch", "Làm Mới", "Thoát"];
  if (transactionRunning) baseItems.splice(1, 0, "Dừng Tất Cả Giao Dịch");
  mainMenu.setItems(baseItems);
  screen.render();
}

function update0gSwapSubMenuItems() {
  const items = ["Bắt đầu Hoán Đổi Tất Cả Cặp", "Xóa Nhật Ký Giao Dịch", "Quay Lại Menu Chính", "Thoát"];
  if (transactionRunning) items.unshift("Dừng Giao Dịch");
  autoSwapSubMenu.setItems(items);
  screen.render();
}

autoSwapSubMenu.hide();
queueMenu.hide();
exitButton.on("press", () => {
  queueMenu.hide();
  mainMenu.show();
  mainMenu.focus();
  screen.render();
});
queueMenu.append(exitButton);

async function updateWalletData() {
  try {
    let content = "┌── Thông Tin Ví\n";
    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];
      content += 
`│   ├── Ví ${i + 1}
│   │   ├── Địa Chỉ : ${wallet.address.slice(0, 10)}..${wallet.address.slice(-3)}
`;
    }
    content += `└── Mạng       : {bright-cyan-fg}${NETWORK_NAME}{/bright-cyan-fg}`;
    walletBox.setContent(content);
    screen.render();
    addLog("Dữ liệu ví đã được cập nhật thành công.", "system");
  } catch (error) {
    addLog("Không thể lấy dữ liệu ví: " + error.message, "error");
  }
}

async function approveToken(walletIndex, tokenAddress, tokenAbi, amount) {
  const wallet = wallets[walletIndex];
  try {
    const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, wallet);
    const currentAllowance = await tokenContract.allowance(wallet.address, ROUTER_ADDRESS);
    if (currentAllowance >= amount) {
      addLog(`0G: Không cần phê duyệt cho ví ${walletIndex + 1}`, "system");
      return;
    }
    const feeData = await provider.getFeeData();
    const tx = await tokenContract.approve(ROUTER_ADDRESS, amount, {
      gasLimit: APPROVAL_GAS_LIMIT,
      gasPrice: feeData.gasPrice
    });
    addLog(`0G: Giao dịch phê duyệt ví ${walletIndex + 1} đã gửi: ${shortHash(tx.hash)}`, "0g");
    await tx.wait();
    addLog(`0G: Phê duyệt thành công cho ví ${walletIndex + 1}.`, "0g");
  } catch (error) {
    addLog(`0G: Phê duyệt thất bại cho ví ${walletIndex + 1}: ${error.message}`, "error");
    throw error;
  }
}

async function swapAuto(walletIndex, direction, amountIn) {
  const wallet = wallets[walletIndex];
  try {
    const swapContract = new ethers.Contract(ROUTER_ADDRESS, CONTRACT_ABI, wallet);
    let params;
    const deadline = Math.floor(Date.now() / 1000) + 120;
    if (direction === "usdtToEth") {
      params = { tokenIn: USDT_ADDRESS, tokenOut: ETH_ADDRESS, fee: 3000, recipient: wallet.address, deadline, amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0n };
    } else if (direction === "ethToUsdt") {
      params = { tokenIn: ETH_ADDRESS, tokenOut: USDT_ADDRESS, fee: 3000, recipient: wallet.address, deadline, amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0n };
    } else if (direction === "usdtToBtc") {
      params = { tokenIn: USDT_ADDRESS, tokenOut: BTC_ADDRESS, fee: 3000, recipient: wallet.address, deadline, amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0n };
    } else if (direction === "btcToUsdt") {
      params = { tokenIn: BTC_ADDRESS, tokenOut: USDT_ADDRESS, fee: 3000, recipient: wallet.address, deadline, amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0n };
    } else if (direction === "btcToEth") {
      params = { tokenIn: BTC_ADDRESS, tokenOut: ETH_ADDRESS, fee: 3000, recipient: wallet.address, deadline, amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0n };
    } else if (direction === "ethToBtc") {
      params = { tokenIn: ETH_ADDRESS, tokenOut: BTC_ADDRESS, fee: 3000, recipient: wallet.address, deadline, amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0n };
    } else {
      throw new Error("Hướng hoán đổi không xác định");
    }
    const gasPriceToUse = selectedGasPrice || (await provider.getFeeData()).gasPrice;
    const tx = await swapContract.exactInputSingle(params, {
      gasLimit: SWAP_GAS_LIMIT,
      gasPrice: gasPriceToUse,
      nonce: nextNonces[walletIndex] || await provider.getTransactionCount(wallet.address, "pending")
    });
    addLog(`0G: Giao dịch hoán đổi ví ${walletIndex + 1} đã gửi: ${shortHash(tx.hash)}`, "0g");
    const receipt = await tx.wait();
    nextNonces[walletIndex] = (nextNonces[walletIndex] || await provider.getTransactionCount(wallet.address, "pending")) + 1;
    addLog(`0G: Giao dịch hoán đổi thành công ví ${walletIndex + 1}: ${shortHash(tx.hash)}`, "0g");
  } catch (error) {
    addLog(`0G: Hoán đổi thất bại ví ${walletIndex + 1}: ${error.message}`, "error");
    throw error;
  }
}

async function autoSwapAllPairs(totalSwaps) {
  try {
    const pairs = [
      { from: "USDT", to: "ETH", tokenIn: USDT_ADDRESS, tokenOut: ETH_ADDRESS, abi: USDT_ABI },
      { from: "ETH", to: "USDT", tokenIn: ETH_ADDRESS, tokenOut: USDT_ADDRESS, abi: ETH_ABI },
      { from: "USDT", to: "BTC", tokenIn: USDT_ADDRESS, tokenOut: BTC_ADDRESS, abi: USDT_ABI },
      { from: "BTC", to: "USDT", tokenIn: BTC_ADDRESS, tokenOut: USDT_ADDRESS, abi: BTC_ABI },
      { from: "BTC", to: "ETH", tokenIn: BTC_ADDRESS, tokenOut: ETH_ADDRESS, abi: BTC_ABI },
      { from: "ETH", to: "BTC", tokenIn: ETH_ADDRESS, tokenOut: BTC_ADDRESS, abi: ETH_ABI },
    ];

    for (let i = 1; i <= totalSwaps; i++) {
      if (!transactionRunning) return;
      const walletIndex = (i - 1) % wallets.length;

      for (const pair of pairs) {
        const amount = pair.from === "USDT" ? ethers.parseUnits("1", 18) : ethers.parseUnits("0.001", 18); // 1 USDT khi từ USDT, 0.001 cho các trường hợp khác
        const tokenContract = new ethers.Contract(pair.tokenIn, pair.abi, provider);
        const currentBalance = await tokenContract.balanceOf(wallets[walletIndex].address);

        if (currentBalance < amount) {
          addLog(`0G: Ví ${walletIndex + 1} số dư ${pair.from} không đủ`, "error");
        } else {
          await addTransactionToQueue(async () => {
            await approveToken(walletIndex, pair.tokenIn, pair.abi, amount);
            await swapAuto(walletIndex, `${pair.from.toLowerCase()}To${pair.to.toLowerCase()}`, amount);
            await updateWalletData();
          }, `Ví ${walletIndex + 1}: ${pair.from} ➯ ${pair.to}, ${pair.from === "USDT" ? "1" : "0.001"} ${pair.from}`);
        }

        if (!transactionRunning) return;
        const delaySeconds = Math.floor(Math.random() * (15 - 3 + 1)) + 3; // Giảm thời gian chờ từ 3 đến 15 giây
        addLog(`0G: Đợi ${delaySeconds} giây trước khi hoán đổi cặp tiếp theo...`, "0g");
        await interruptibleDelay(delaySeconds * 1000);
      }
    }
    addLog("0G: Hoàn tất tất cả hoán đổi cho các cặp token.", "0g");
  } catch (error) {
    addLog(`0G: Lỗi autoSwapAllPairs: ${error.message}`, "error");
  } finally {
    stopTransaction();
  }
}

function addTransactionToQueue(transactionFunction, description = "Giao Dịch") {
  const transactionId = ++transactionIdCounter;
  transactionQueueList.push({ id: transactionId, description, timestamp: new Date().toLocaleTimeString('vi-VN'), status: "đang chờ" });
  addLog(`Giao dịch [${transactionId}] đã thêm: ${description}`, "system");
  updateQueueDisplay();
  transactionQueue = transactionQueue.then(async () => {
    updateTransactionStatus(transactionId, "đang xử lý");
    try {
      await transactionFunction();
      updateTransactionStatus(transactionId, "hoàn tất");
    } catch (error) {
      updateTransactionStatus(transactionId, "lỗi");
      addLog(`Giao dịch [${transactionId}] thất bại: ${error.message}`, "error");
    } finally {
      removeTransactionFromQueue(transactionId);
    }
  });
  return transactionQueue;
}

function updateTransactionStatus(id, status) {
  transactionQueueList.forEach(tx => { if (tx.id === id) tx.status = status; });
  updateQueueDisplay();
}

function removeTransactionFromQueue(id) {
  transactionQueueList = transactionQueueList.filter(tx => tx.id !== id);
  updateQueueDisplay();
}

function getTransactionQueueContent() {
  return transactionQueueList.length === 0 ? "Không có giao dịch nào trong hàng đợi." : transactionQueueList.map(tx => `ID: ${tx.id} | ${tx.description} | ${tx.status} | ${tx.timestamp}`).join("\n");
}

function updateQueueDisplay() {
  if (queueMenu.visible) {
    queueMenu.setContent(getTransactionQueueContent());
    screen.render();
  }
}

function showTransactionQueueMenu() {
  queueMenu.setContent(getTransactionQueueContent());
  queueMenu.show();
  queueMenu.focus();
  screen.render();
  queueMenu.key(["escape", "q", "C-c"], () => {
    queueMenu.hide();
    mainMenu.show();
    mainMenu.focus();
    screen.render();
  });
}

function stopTransaction() {
  transactionRunning = false;
  chosenSwap = null;
  updateMainMenuItems();
  update0gSwapSubMenuItems();
  screen.render();
}

function stopAllTransactions() {
  if (transactionRunning) {
    stopTransaction();
    addLog("Tất cả giao dịch đã bị dừng.", "system");
  } else {
    addLog("Không có giao dịch nào đang chạy.", "system");
  }
}

async function chooseGasFee() {
  return new Promise((resolve, reject) => {
    const container = blessed.box({
      label: ' Chọn Phí Gas ',
      top: 'center',
      left: 'center',
      width: '50%',
      height: 8,
      border: { type: 'line' },
      style: { border: { fg: 'blue' } },
      tags: true,
    });

    const gasFeeList = blessed.list({
      top: 0,
      left: 0,
      width: '100%',
      height: 5,
      items: ['Gas Bình Thường', 'Gas Thấp', 'Gas Phí x2'],
      keys: true,
      mouse: true,
      style: { selected: { bg: 'blue', fg: 'white' } },
    });
    container.append(gasFeeList);

    const cancelButton = blessed.button({
      content: 'Hủy',
      bottom: 0,
      left: 'center',
      shrink: true,
      padding: { left: 1, right: 1 },
      border: { type: 'line' },
      style: { fg: 'white', bg: 'red', border: { fg: 'white' }, hover: { bg: 'blue' } },
      mouse: true,
      keys: true,
    });
    cancelButton.on('press', () => {
      container.destroy();
      autoSwapSubMenu.focus();
      screen.render();
      reject("Hủy chọn phí gas");
    });
    container.append(cancelButton);

    screen.append(container);
    gasFeeList.focus();
    screen.render();

    gasFeeList.on('select', async (item, index) => {
      container.destroy();
      try {
        const feeData = await provider.getFeeData();
        const gasPriceBN = feeData.gasPrice;
        let selected;
        if (index === 0) selected = gasPriceBN;
        else if (index === 1) selected = gasPriceBN * 80n / 100n;
        else if (index === 2) selected = gasPriceBN * 2n;
        autoSwapSubMenu.focus();
        screen.render();
        resolve(selected);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function startTransactionProcess(totalSwaps) {
  chooseGasFee().then(gasPrice => {
    selectedGasPrice = gasPrice;
    addLog(`Phí gas đã chọn: ${ethers.formatUnits(selectedGasPrice, "gwei")} Gwei`, "system");
    transactionRunning = true;
    chosenSwap = "All Pairs";
    updateMainMenuItems();
    update0gSwapSubMenuItems();
    autoSwapAllPairs(totalSwaps);
  }).catch(err => {
    addLog("Hủy chọn phí gas: " + err, "system");
  });
}

mainMenu.on("select", (item) => {
  const selected = item.getText();
  if (selected === "Hoán Đổi 0g") {
    mainMenu.hide();
    autoSwapSubMenu.show();
    autoSwapSubMenu.focus();
    screen.render();
  } else if (selected === "Hàng Đợi Giao Dịch") {
    showTransactionQueueMenu();
  } else if (selected === "Dừng Tất Cả Giao Dịch") {
    stopAllTransactions();
  } else if (selected === "Xóa Nhật Ký Giao Dịch") {
    clearTransactionLogs();
  } else if (selected === "Làm Mới") {
    updateWalletData();
  } else if (selected === "Thoát") {
    process.exit(0);
  }
});

autoSwapSubMenu.on("select", (item) => {
  const selected = item.getText();
  if (transactionRunning && !["Dừng Giao Dịch", "Xóa Nhật Ký Giao Dịch", "Quay Lại Menu Chính", "Thoát"].includes(selected)) {
    addLog("Đang có giao dịch chạy. Vui lòng dừng trước.", "system");
    return;
  }
  if (selected === "Bắt đầu Hoán Đổi Tất Cả Cặp") {
    promptBox.setLabel("{bright-blue-fg}Số Lượng Hoán Đổi (Tất Cả Cặp){/bright-blue-fg}");
    promptBox.setFront();
    promptBox.readInput("Nhập số lượng hoán đổi:", "", (err, value) => {
      promptBox.hide();
      screen.render();
      if (err || !value) return addLog("Hủy nhập số lượng hoán đổi.", "system");
      const totalSwaps = parseInt(value);
      if (isNaN(totalSwaps) || totalSwaps <= 0) return addLog("Số lượng hoán đổi không hợp lệ.", "error");
      startTransactionProcess(totalSwaps);
    });
  } else if (selected === "Dừng Giao Dịch") {
    stopTransaction();
  } else if (selected === "Xóa Nhật Ký Giao Dịch") {
    clearTransactionLogs();
  } else if (selected === "Quay Lại Menu Chính") {
    autoSwapSubMenu.hide();
    mainMenu.show();
    mainMenu.focus();
    screen.render();
  } else if (selected === "Thoát") {
    process.exit(0);
  }
});

function adjustLayout() {
  const screenWidth = screen.width;
  const screenHeight = screen.height;
  const headerHeight = Math.max(8, Math.floor(screenHeight * 0.15));
  headerBox.top = 0;
  headerBox.width = "100%";
  headerBox.height = headerHeight;
  descriptionBox.top = "25%";
  descriptionBox.height = Math.floor(screenHeight * 0.05);
  logsBox.top = headerHeight + descriptionBox.height;
  logsBox.left = 0;
  logsBox.width = Math.floor(screenWidth * 0.6);
  logsBox.height = Math.floor(screenHeight * 0.5);
  gasPriceBox.top = logsBox.top + logsBox.height;
  gasPriceBox.left = logsBox.left;
  gasPriceBox.width = logsBox.width;
  gasPriceBox.height = Math.floor(screenHeight * 0.22);
  walletBox.top = headerHeight + descriptionBox.height;
  walletBox.left = Math.floor(screenWidth * 0.6);
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35);
  mainMenu.top = walletBox.top + walletBox.height;
  mainMenu.left = Math.floor(screenWidth * 0.6);
  mainMenu.width = Math.floor(screenWidth * 0.4);
  mainMenu.height = screenHeight - (headerHeight + descriptionBox.height + walletBox.height);
  autoSwapSubMenu.top = mainMenu.top;
  autoSwapSubMenu.left = mainMenu.left;
  autoSwapSubMenu.width = mainMenu.width;
  autoSwapSubMenu.height = mainMenu.height;
  screen.render();
}

// Gắn các thành phần UI vào screen
screen.append(headerBox);
screen.append(descriptionBox);
screen.append(logsBox);
screen.append(gasPriceBox);
screen.append(walletBox);
screen.append(mainMenu);
screen.append(autoSwapSubMenu);
screen.append(queueMenu);

screen.on("resize", adjustLayout);
screen.key(["escape", "q", "C-c"], () => process.exit(0));

adjustLayout();
mainMenu.focus();
updateWalletData();
updateMainMenuItems();
update0gSwapSubMenuItems();
screen.render();
