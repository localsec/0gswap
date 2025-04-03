import "dotenv/config";
import blessed from "blessed";
import figlet from "figlet";
import { ethers } from "ethers";

const RPC_URL = process.env.RPC_URL || "https://your-default-rpc-url";
const PRIVATE_KEYS_RAW = process.env.PRIVATE_KEYS || "";
if (!PRIVATE_KEYS_RAW) {
  console.error("Lỗi: Không tìm thấy PRIVATE_KEYS trong .env");
  process.exit(1);
}
const PRIVATE_KEYS = PRIVATE_KEYS_RAW.split(",").map(key => {
  key = key.trim();
  // Nếu key không có 0x và dài 64 ký tự hex, thêm 0x
  if (!key.startsWith("0x") && key.match(/^[0-9a-fA-F]{64}$/)) {
    return "0x" + key;
  }
  // Nếu đã có 0x, giữ nguyên
  return key;
}).filter(key => key);

const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS;
const USDT_ADDRESS = process.env.USDT_ADDRESS;
const ETH_ADDRESS = process.env.ETH_ADDRESS;
const BTC_ADDRESS = process.env.BTC_ADDRESS;
const AOGI_ADDRESS = process.env.AOGI_ADDRESS;
const NETWORK_NAME = process.env.NETWORK_NAME || "Unknown Network";
const APPROVAL_GAS_LIMIT = 100000;
const SWAP_GAS_LIMIT = 150000;
const ESTIMATED_GAS_USAGE = 150000;

const provider = new ethers.JsonRpcProvider(RPC_URL);

console.log("Raw PRIVATE_KEYS từ .env:", PRIVATE_KEYS_RAW);
console.log("PRIVATE_KEYS sau khi xử lý:", PRIVATE_KEYS);

const wallets = PRIVATE_KEYS.map((key, index) => {
  try {
    // Kiểm tra định dạng: phải là 0x + 64 ký tự hex sau khi xử lý
    if (!key.match(/^0x[0-9a-fA-F]{64}$/)) {
      throw new Error(`Private key ${index + 1} không đúng định dạng (64 ký tự hex)`);
    }
    const wallet = new ethers.Wallet(key, provider);
    console.log(`Ví ${index + 1} được tạo: ${wallet.address}`);
    return wallet;
  } catch (error) {
    console.error(`Lỗi với private key ${index + 1}: ${error.message}`);
    process.exit(1);
  }
});

// ABI definitions (giữ nguyên)
const CONTRACT_ABI = [/* ... */];
const USDT_ABI = [/* ... */];
const ETH_ABI = [/* ... */];
const BTC_ABI = [/* ... */];

let transactionRunning = false;
let chosenSwap = null;
let transactionQueue = Promise.resolve();
let transactionQueueList = [];
let transactionIdCounter = 0;
let nextNonces = wallets.map(() => null);
let selectedGasPrice = null;

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

let transactionLogs = [];
let renderTimeout;
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

const screen = blessed.screen({ smartCSR: true, title: "LocalSec", fullUnicode: true, mouse: true });
// ... UI setup giữ nguyên

async function updateWalletData() {
  try {
    let content = "┌── Thông Tin Ví\n";
    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];
      const balanceNative = await provider.getBalance(wallet.address);
      const saldoAOGI = parseFloat(ethers.formatEther(balanceNative)).toFixed(4);
      const usdtContract = new ethers.Contract(USDT_ADDRESS, USDT_ABI, provider);
      const balanceUSDT = await usdtContract.balanceOf(wallet.address);
      const saldoUSDT = parseFloat(ethers.formatEther(balanceUSDT)).toFixed(4);
      const ethContract = new ethers.Contract(ETH_ADDRESS, ETH_ABI, provider);
      const balanceETH = await ethContract.balanceOf(wallet.address);
      const saldoETH = parseFloat(ethers.formatEther(balanceETH)).toFixed(4);
      const btcContract = new ethers.Contract(BTC_ADDRESS, BTC_ABI, provider);
      const balanceBTC = await btcContract.balanceOf(wallet.address);
      const saldoBTC = parseFloat(ethers.formatUnits(balanceBTC, 18)).toFixed(4);

      content += 
`│   ├── Ví ${i + 1}
│   │   ├── Địa Chỉ : ${wallet.address.slice(0, 10)}..${wallet.address.slice(-3)}
│   │   ├── AOGI    : {bright-green-fg}${saldoAOGI}{/bright-green-fg}
│   │   ├── ETH     : {bright-green-fg}${saldoETH}{/bright-green-fg}
│   │   ├── USDT    : {bright-green-fg}${saldoUSDT}{/bright-green-fg}
│   │   └── BTC     : {bright-green-fg}${saldoBTC}{/bright-green-fg}
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

async function approveToken(walletIndex, tokenAddress, tokenAbi, amount, decimals) {
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

async function autoSwapUsdtEth(totalSwaps) {
  try {
    for (let i = 1; i <= totalSwaps; i++) {
      if (!transactionRunning) return;
      const walletIndex = (i - 1) % wallets.length;
      if (i % 2 === 1) {
        const randomUsdt = (Math.random() * (300 - 100) + 100).toFixed(2);
        const usdtAmount = ethers.parseUnits(randomUsdt, 18);
        const usdtContract = new ethers.Contract(USDT_ADDRESS, USDT_ABI, provider);
        const currentUsdtBalance = await usdtContract.balanceOf(wallets[walletIndex].address);
        if (currentUsdtBalance < usdtAmount) {
          addLog(`0G: Ví ${walletIndex + 1} số dư USDT không đủ`, "error");
        } else {
          await addTransactionToQueue(async () => {
            await approveToken(walletIndex, USDT_ADDRESS, USDT_ABI, usdtAmount, 18);
            await swapAuto(walletIndex, "usdtToEth", usdtAmount);
            await updateWalletData();
          }, `Ví ${walletIndex + 1}: USDT ➯ ETH, ${randomUsdt} USDT`);
        }
      } else {
        const randomEth = (Math.random() * (0.3 - 0.1) + 0.1).toFixed(6);
        const ethAmount = ethers.parseUnits(randomEth, 18);
        const ethContract = new ethers.Contract(ETH_ADDRESS, ETH_ABI, provider);
        const currentEthBalance = await ethContract.balanceOf(wallets[walletIndex].address);
        if (currentEthBalance < ethAmount) {
          addLog(`0G: Ví ${walletIndex + 1} số dư ETH không đủ`, "error");
        } else {
          await addTransactionToQueue(async () => {
            await approveToken(walletIndex, ETH_ADDRESS, ETH_ABI, ethAmount, 18);
            await swapAuto(walletIndex, "ethToUsdt", ethAmount);
            await updateWalletData();
          }, `Ví ${walletIndex + 1}: ETH ➯ USDT, ${randomEth} ETH`);
        }
      }
      if (i < totalSwaps) {
        const delaySeconds = Math.floor(Math.random() * (60 - 30 + 1)) + 30;
        addLog(`0G: Đợi ${delaySeconds} giây...`, "0g");
        await interruptibleDelay(delaySeconds * 1000);
      }
    }
    addLog("0G: Hoàn tất tất cả hoán đổi USDT & ETH.", "0g");
  } catch (error) {
    addLog(`0G: Lỗi autoSwapUsdtEth: ${error.message}`, "error");
  } finally {
    stopTransaction();
  }
}

async function autoSwapUsdtBtc(totalSwaps) {
  try {
    for (let i = 1; i <= totalSwaps; i++) {
      if (!transactionRunning) return;
      const walletIndex = (i - 1) % wallets.length;
      if (i % 2 === 1) {
        const randomUsdt = (Math.random() * (300 - 100) + 100).toFixed(2);
        const usdtAmount = ethers.parseUnits(randomUsdt, 18);
        const usdtContract = new ethers.Contract(USDT_ADDRESS, USDT_ABI, provider);
        const currentUsdtBalance = await usdtContract.balanceOf(wallets[walletIndex].address);
        if (currentUsdtBalance < usdtAmount) {
          addLog(`0G: Ví ${walletIndex + 1} số dư USDT không đủ`, "error");
        } else {
          await addTransactionToQueue(async () => {
            await approveToken(walletIndex, USDT_ADDRESS, USDT_ABI, usdtAmount, 18);
            await swapAuto(walletIndex, "usdtToBtc", usdtAmount);
            await updateWalletData();
          }, `Ví ${walletIndex + 1}: USDT ➯ BTC, ${randomUsdt} USDT`);
        }
      } else {
        const randomBtc = (Math.random() * (0.05 - 0.01) + 0.01).toFixed(6);
        const btcAmount = ethers.parseUnits(randomBtc, 18);
        const btcContract = new ethers.Contract(BTC_ADDRESS, BTC_ABI, provider);
        const currentBtcBalance = await btcContract.balanceOf(wallets[walletIndex].address);
        if (currentBtcBalance < btcAmount) {
          addLog(`0G: Ví ${walletIndex + 1} số dư BTC không đủ`, "error");
        } else {
          await addTransactionToQueue(async () => {
            await approveToken(walletIndex, BTC_ADDRESS, BTC_ABI, btcAmount, 18);
            await swapAuto(walletIndex, "btcToUsdt", btcAmount);
            await updateWalletData();
          }, `Ví ${walletIndex + 1}: BTC ➯ USDT, ${randomBtc} BTC`);
        }
      }
      if (i < totalSwaps) {
        const delaySeconds = Math.floor(Math.random() * (60 - 30 + 1)) + 30;
        addLog(`0G: Đợi ${delaySeconds} giây...`, "0g");
        await interruptibleDelay(delaySeconds * 1000);
      }
    }
    addLog("0G: Hoàn tất tất cả hoán đổi USDT & BTC.", "0g");
  } catch (error) {
    addLog(`0G: Lỗi autoSwapUsdtBtc: ${error.message}`, "error");
  } finally {
    stopTransaction();
  }
}

async function autoSwapBtcEth(totalSwaps) {
  try {
    for (let i = 1; i <= totalSwaps; i++) {
      if (!transactionRunning) return;
      const walletIndex = (i - 1) % wallets.length;
      if (i % 2 === 1) {
        const randomBtc = (Math.random() * (0.05 - 0.01) + 0.01).toFixed(6);
        const btcAmount = ethers.parseUnits(randomBtc, 18);
        const btcContract = new ethers.Contract(BTC_ADDRESS, BTC_ABI, provider);
        const currentBtcBalance = await btcContract.balanceOf(wallets[walletIndex].address);
        if (currentBtcBalance < btcAmount) {
          addLog(`0G: Ví ${walletIndex + 1} số dư BTC không đủ`, "error");
        } else {
          await addTransactionToQueue(async () => {
            await approveToken(walletIndex, BTC_ADDRESS, BTC_ABI, btcAmount, 18);
            await swapAuto(walletIndex, "btcToEth", btcAmount);
            await updateWalletData();
          }, `Ví ${walletIndex + 1}: BTC ➯ ETH, ${randomBtc} BTC`);
        }
      } else {
        const randomEth = (Math.random() * (0.3 - 0.1) + 0.1).toFixed(6);
        const ethAmount = ethers.parseUnits(randomEth, 18);
        const ethContract = new ethers.Contract(ETH_ADDRESS, ETH_ABI, provider);
        const currentEthBalance = await ethContract.balanceOf(wallets[walletIndex].address);
        if (currentEthBalance < ethAmount) {
          addLog(`0G: Ví ${walletIndex + 1} số dư ETH không đủ`, "error");
        } else {
          await addTransactionToQueue(async () => {
            await approveToken(walletIndex, ETH_ADDRESS, ETH_ABI, ethAmount, 18);
            await swapAuto(walletIndex, "ethToBtc", ethAmount);
            await updateWalletData();
          }, `Ví ${walletIndex + 1}: ETH ➯ BTC, ${randomEth} ETH`);
        }
      }
      if (i < totalSwaps) {
        const delaySeconds = Math.floor(Math.random() * (60 - 30 + 1)) + 30;
        addLog(`0G: Đợi ${delaySeconds} giây...`, "0g");
        await interruptibleDelay(delaySeconds * 1000);
      }
    }
    addLog("0G: Hoàn tất tất cả hoán đổi BTC & ETH.", "0g");
  } catch (error) {
    addLog(`0G: Lỗi autoSwapBtcEth: ${error.message}`, "error");
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

// ... Các hàm UI khác giữ nguyên (updateQueueDisplay, stopTransaction, v.v.)

function startTransactionProcess(pair, totalSwaps) {
  chooseGasFee().then(gasPrice => {
    selectedGasPrice = gasPrice;
    addLog(`Phí gas đã chọn: ${ethers.formatUnits(selectedGasPrice, "gwei")} Gwei`, "system");
    transactionRunning = true;
    chosenSwap = pair;
    updateMainMenuItems();
    update0gSwapSubMenuItems();
    if (pair === "USDT & ETH") autoSwapUsdtEth(totalSwaps);
    else if (pair === "USDT & BTC") autoSwapUsdtBtc(totalSwaps);
    else if (pair === "BTC & ETH") autoSwapBtcEth(totalSwaps);
  }).catch(err => {
    addLog("Hủy chọn phí gas: " + err, "system");
  });
}

// ... Phần còn lại của code (UI setup, event listeners) giữ nguyên

screen.append(headerBox);
screen.append(descriptionBox);
screen.append(logsBox);
screen.append(gasPriceBox);
screen.append(walletBox);
screen.append(mainMenu);
screen.append(autoSwapSubMenu);
screen.append(queueMenu);

adjustLayout();
screen.on("resize", adjustLayout);
screen.key(["escape", "q", "C-c"], () => process.exit(0));

mainMenu.focus();
updateWalletData();
updateMainMenuItems();
update0gSwapSubMenuItems();
screen.render();
