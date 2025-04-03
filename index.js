import "dotenv/config";
import blessed from "blessed";
import figlet from "figlet";
import { ethers } from "ethers";

// Cấu hình nhiều ví từ .env (PRIVATE_KEYS cách nhau bằng dấu phẩy)
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEYS = process.env.PRIVATE_KEYS.split(",").map(key => key.trim());
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS;
const USDT_ADDRESS = process.env.USDT_ADDRESS;
const ETH_ADDRESS = process.env.ETH_ADDRESS;
const BTC_ADDRESS = process.env.BTC_ADDRESS;
const AOGI_ADDRESS = process.env.AOGI_ADDRESS;
const NETWORK_NAME = process.env.NETWORK_NAME;
const APPROVAL_GAS_LIMIT = 100000;
const SWAP_GAS_LIMIT = 150000;
const ESTIMATED_GAS_USAGE = 150000;

const provider = new ethers.JsonRpcProvider(RPC_URL);
// Tạo danh sách wallet từ private keys
const wallets = PRIVATE_KEYS.map(key => new ethers.Wallet(key, provider));

// ABI definitions (giữ nguyên như code gốc)
const CONTRACT_ABI = [/* ... */];
const USDT_ABI = [/* ... */];
const ETH_ABI = [/* ... */];
const BTC_ABI = [/* ... */];

let transactionRunning = false;
let chosenSwap = null;
let transactionQueue = Promise.resolve();
let transactionQueueList = [];
let transactionIdCounter = 0;
let nextNonces = wallets.map(() => null); // Mảng nonce cho từng wallet
let selectedGasPrice = null;

// Các hàm tiện ích (giữ nguyên)
function delay(ms) { /* ... */ }
function shortHash(hash) { /* ... */ }
async function interruptibleDelay(totalMs) { /* ... */ }

// UI setup (giữ nguyên phần lớn)
const screen = blessed.screen({ /* ... */ });
// ... các box khác giữ nguyên

// Điều chỉnh updateWalletData để hiển thị thông tin nhiều ví
async function updateWalletData() {
  try {
    let content = "┌── Thông Tin Ví\n";
    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];
      const walletAddress = wallet.address;
      const balanceNative = await provider.getBalance(walletAddress);
      const saldoAOGI = parseFloat(ethers.formatEther(balanceNative)).toFixed(4);

      const usdtContract = new ethers.Contract(USDT_ADDRESS, USDT_ABI, provider);
      const balanceUSDT = await usdtContract.balanceOf(walletAddress);
      const saldoUSDT = parseFloat(ethers.formatEther(balanceUSDT)).toFixed(4);

      const ethContract = new ethers.Contract(ETH_ADDRESS, ETH_ABI, provider);
      const balanceETH = await ethContract.balanceOf(walletAddress);
      const saldoETH = parseFloat(ethers.formatEther(balanceETH)).toFixed(4);

      const btcContract = new ethers.Contract(BTC_ADDRESS, BTC_ABI, provider);
      const balanceBTC = await btcContract.balanceOf(walletAddress);
      const saldoBTC = parseFloat(ethers.formatUnits(balanceBTC, 18)).toFixed(4);

      content += 
`│   ├── Ví ${i + 1}
│   │   ├── Địa Chỉ : ${walletAddress.slice(0, 10)}..${walletAddress.slice(-3)}
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

// Điều chỉnh approveToken để hỗ trợ wallet cụ thể
async function approveToken(walletIndex, tokenAddress, tokenAbi, amount, decimals) {
  try {
    const wallet = wallets[walletIndex];
    const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, wallet);
    const currentAllowance = await tokenContract.allowance(wallet.address, ROUTER_ADDRESS);
    if (currentAllowance >= amount) {
      addLog(`0G: Không cần phê duyệt cho ví ${walletIndex + 1}, Allowance đã đủ`, "system");
      return;
    }
    const feeData = await provider.getFeeData();
    const currentGasPrice = feeData.gasPrice;
    const tx = await tokenContract.approve(ROUTER_ADDRESS, amount, {
      gasLimit: APPROVAL_GAS_LIMIT,
      gasPrice: currentGasPrice
    });
    addLog(`0G: Giao dịch phê duyệt ví ${walletIndex + 1} đã gửi: ${shortHash(tx.hash)}`, "0g");
    await tx.wait();
    addLog(`0G: Phê duyệt thành công cho ví ${walletIndex + 1}.`, "0g");
  } catch (error) {
    addLog(`0G: Phê duyệt thất bại cho ví ${walletIndex + 1}: ` + error.message, "error");
    throw error;
  }
}

// Điều chỉnh swapAuto để hỗ trợ wallet cụ thể
async function swapAuto(walletIndex, direction, amountIn) {
  try {
    const wallet = wallets[walletIndex];
    const swapContract = new ethers.Contract(ROUTER_ADDRESS, CONTRACT_ABI, wallet);
    let params;
    const deadline = Math.floor(Date.now() / 1000) + 120;
    // ... logic params giữ nguyên như code gốc

    const gasPriceToUse = selectedGasPrice || (await provider.getFeeData()).gasPrice;
    const tx = await swapContract.exactInputSingle(params, {
      gasLimit: SWAP_GAS_LIMIT,
      gasPrice: gasPriceToUse,
      nonce: nextNonces[walletIndex]
    });
    addLog(`0G: Giao dịch hoán đổi ví ${walletIndex + 1} đã gửi: ${shortHash(tx.hash)}`, "0g");
    const receipt = await tx.wait();
    nextNonces[walletIndex] = (nextNonces[walletIndex] || await provider.getTransactionCount(wallet.address, "pending")) + 1;
    // ... log giao dịch thành công
  } catch (error) {
    // ... xử lý lỗi và cập nhật nonce
  }
}

// Điều chỉnh autoSwapUsdtEth để sử dụng nhiều ví
async function autoSwapUsdtEth(totalSwaps) {
  try {
    for (let i = 1; i <= totalSwaps; i++) {
      if (!transactionRunning) return;
      const walletIndex = i % wallets.length; // Luân phiên sử dụng các ví
      if (i % 2 === 1) {
        // USDT -> ETH
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
        // ETH -> USDT
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
      // ... logic delay giữ nguyên
    }
  } catch (error) {
    // ... xử lý lỗi
  } finally {
    stopTransaction();
  }
}

// Tương tự điều chỉnh autoSwapUsdtBtc và autoSwapBtcEth

// Điều chỉnh addTransactionToQueue để theo dõi nonce riêng cho từng ví
function addTransactionToQueue(transactionFunction, description = "Giao Dịch") {
  const transactionId = ++transactionIdCounter;
  transactionQueueList.push({
    id: transactionId,
    description,
    timestamp: new Date().toLocaleTimeString('vi-VN'),
    status: "đang chờ"
  });
  // ... logic queue giữ nguyên
  transactionQueue = transactionQueue.then(async () => {
    // ... xử lý giao dịch
    try {
      const walletIndex = parseInt(description.match(/Ví (\d+)/)?.[1] || "1") - 1;
      if (nextNonces[walletIndex] === null) {
        nextNonces[walletIndex] = await provider.getTransactionCount(wallets[walletIndex].address, "pending");
      }
      const result = await transactionFunction();
      // ... cập nhật trạng thái
    } catch (error) {
      // ... xử lý lỗi
    }
  });
  return transactionQueue;
}

// Trong file .env, thêm PRIVATE_KEYS:
// PRIVATE_KEYS=privatekey1,privatekey2,privatekey3
