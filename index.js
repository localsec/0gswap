import "dotenv/config";
import blessed from "blessed";
import figlet from "figlet";
import { ethers } from "ethers";

// Cấu hình nhiều ví từ biến môi trường
const WALLETS = process.env.PRIVATE_KEYS.split(",").map((key, index) => ({
  privateKey: key.trim(),
  wallet: new ethers.Wallet(key.trim(), new ethers.JsonRpcProvider(process.env.RPC_URL)),
  index: index + 1 // Số thứ tự ví để hiển thị
}));

const RPC_URL = process.env.RPC_URL;
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS;
const USDT_ADDRESS = process.env.USDT_ADDRESS;
const ETH_ADDRESS = process.env.ETH_ADDRESS;
const BTC_ADDRESS = process.env.BTC_ADDRESS;
const AOGI_ADDRESS = process.env.AOGI_ADDRESS;
const NETWORK_NAME = process.env.NETWORK_NAME;
const APPROVAL_GAS_LIMIT = 100000;
const SWAP_GAS_LIMIT = 150000;
const ESTIMATED_GAS_USAGE = 150000;

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
  {
    constant: false,
    inputs: [
      { name: "_spender", type: "address" },
      { name: "_value", type: "uint256" }
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    constant: true,
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_spender", type: "address" }
    ],
    name: "allowance",
    outputs: [{ name: "remaining", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  }
];

const ETH_ABI = [...USDT_ABI];
const BTC_ABI = [...USDT_ABI];

let transactionRunning = false;
let chosenSwap = null;
let transactionQueue = Promise.resolve();
let transactionQueueList = [];
let transactionIdCounter = 0;
let nextNonces = WALLETS.map(() => null);
let selectedGasPrice = null;
let autoSwap24hRunning = false;
let autoSwap24hInterval = null;
let nextSwapTime = null;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shortHash(hash) {
  return `${hash.substring(0, 6)}...${hash.substring(hash.length - 4)}`;
}

async function interruptibleDelay(totalMs) {
  const interval = 200;
  let elapsed = 0;
  while (elapsed < totalMs) {
    if (!transactionRunning && !autoSwap24hRunning) break;
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
  if (typeof logsBox.getScrollHeight === "function" && typeof logsBox.scrollTo === "function") {
    logsBox.scrollTo(logsBox.getScrollHeight());
  } else if (typeof logsBox.setScrollPerc === "function") {
    logsBox.setScrollPerc(100);
  }
  safeRender();
}

function addLog(message, type) {
  const timestamp = new Date().toLocaleTimeString();
  let coloredMessage = message;
  if (type === "system") {
    coloredMessage = `{bright-white-fg}${message}{/bright-white-fg}`;
  } else if (type === "0g") {
    coloredMessage = `{bright-cyan-fg}${message}{/bright-cyan-fg}`;
  }
  transactionLogs.push(`[ {bold}{grey-fg}${timestamp}{/grey-fg}{/bold} ] ${coloredMessage}`);
  updateLogs();
}

function clearTransactionLogs() {
  transactionLogs = [];
  updateLogs();
  addLog("Nhật ký giao dịch đã được xóa.", "system");
}

const screen = blessed.screen({
  smartCSR: true,
  title: "NT Exhaust",
  fullUnicode: true,
  mouse: true
});

const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  tags: true,
  style: { fg: "white" }
});
figlet.text("NT EXHAUST", { font: "Speed", horizontalLayout: "default" }, (err, data) => {
  if (err) headerBox.setContent("{center}{bold}NT EXHAUST{/bold}{/center}");
  else headerBox.setContent(`{center}{bold}{green-fg}${data}{/green-fg}{/bold}{/center}`);
  screen.render();
});

const descriptionBox = blessed.box({
  left: "center",
  width: "100%",
  content: "{center}{bold}{bright-yellow-fg}                               « ✮ 0̲̅G̲̅ L̲̅A̲̅B̲̅S̲̅ T̲̅Ự̲̅ Đ̲̅Ộ̲̅N̲̅G̲̅ S̲̅W̲̅A̲̅P̲̅ ✮ »{/bright-yellow-fg}{/bold}{/center}",
  tags: true,
  style: { fg: "white", bg: "default" }
});

const logsBox = blessed.box({
  label: " Nhật Ký Giao Dịch ",
  border: { type: "line" },
  top: 0,
  left: 0,
  width: "60%",
  height: 10,
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  vi: true,
  tags: true,
  scrollbar: { ch: " ", inverse: true, style: { bg: "blue" } },
  style: { border: { fg: "red" }, fg: "bright-cyan", bg: "default" }
});

const walletBox = blessed.box({
  label: " Thông Tin Ví ",
  border: { type: "line" },
  tags: true,
  style: { border: { fg: "magenta" }, fg: "white", bg: "default", align: "left", valign: "top" },
  content: "Đang lấy dữ liệu ví..."
});

const gasPriceBox = blessed.box({
  label: " Thông Tin Giá Gas ",
  tags: true,
  border: { type: "line" },
  style: { border: { fg: "blue" }, fg: "white" },
  content: "Đang tải giá gas..."
});

const countdownBox = blessed.box({
  label: " Đếm Ngược Swap 24h ",
  border: { type: "line" },
  tags: true,
  style: { border: { fg: "green" }, fg: "white", bg: "default" },
  content: "Chưa kích hoạt tự động swap 24h",
  hidden: true
});

async function updateGasPriceBox() {
  try {
    const provider = WALLETS[0].wallet.provider;
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
    addLog("Không thể cập nhật Hộp Giá Gas: " + error.message, "error");
  }
}
setInterval(updateGasPriceBox, 10000);
updateGasPriceBox();

function updateCountdownBox() {
  if (!autoSwap24hRunning || !nextSwapTime) {
    countdownBox.setContent("Chưa kích hoạt tự động swap 24h");
    countdownBox.hide();
    return;
  }
  countdownBox.show();
  const now = Date.now();
  const timeLeft = nextSwapTime - now;
  if (timeLeft <= 0) {
    countdownBox.setContent("Đang thực hiện swap...");
  } else {
    const hours = Math.floor(timeLeft / (1000 * 60 * 60));
    const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);
    countdownBox.setContent(`Swap tiếp theo sau: ${hours}h ${minutes}m ${seconds}s`);
  }
  screen.render();
}
setInterval(updateCountdownBox, 1000);

function updateMainMenuItems() {
  const baseItems = ["Swap 0g", "Hàng Đợi Giao Dịch", "Xóa Nhật Ký Giao Dịch", "Làm Mới", "Thoát"];
  if (transactionRunning || autoSwap24hRunning) baseItems.splice(1, 0, "Dừng Tất Cả Giao Dịch");
  mainMenu.setItems(baseItems);
  screen.render();
}

const mainMenu = blessed.list({
  label: " Menu ",
  left: "60%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "yellow" }, selected: { bg: "green", fg: "black" } },
  items: []
});

function update0gSwapSubMenuItems() {
  const items = [
    "Tự Động Swap USDT & ETH",
    "Tự Động Swap USDT & BTC",
    "Tự Động Swap BTC & ETH",
    "Tự Động Swap Tất Cả Cặp",
    "Tự Động Swap 24h",
    "Xóa Nhật Ký Giao Dịch",
    "Quay Lại Menu Chính",
    "Thoát"
  ];
  if (transactionRunning || autoSwap24hRunning) items.unshift("Dừng Giao Dịch");
  autoSwapSubMenu.setItems(items);
  screen.render();
}

const autoSwapSubMenu = blessed.list({
  label: " Menu Tự Động Swap ",
  left: "60%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: { selected: { bg: "blue", fg: "white" }, border: { fg: "yellow" }, fg: "white" },
  items: []
});
autoSwapSubMenu.hide();

const queueMenu = blessed.box({
  label: " Hàng Đợi Giao Dịch ",
  top: "10%",
  left: "center",
  width: "80%",
  height: "80%",
  border: { type: "line" },
  style: { border: { fg: "blue" } },
  scrollable: true,
  keys: true,
  mouse: true,
  alwaysScroll: true,
  tags: true
});
queueMenu.hide();

const exitButton = blessed.button({
  content: " Thoát ",
  bottom: 0,
  left: "center",
  shrink: true,
  padding: { left: 1, right: 1 },
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "red",
    border: { fg: "white" },
    hover: { bg: "blue" }
  },
  mouse: true,
  keys: true
});
exitButton.on("press", () => {
  queueMenu.hide();
  mainMenu.show();
  mainMenu.focus();
  screen.render();
});
queueMenu.append(exitButton);

const promptBox = blessed.prompt({
  parent: screen,
  border: "line",
  height: "20%",
  width: "50%",
  top: "center",
  left: "center",
  label: "{bright-blue-fg}Số Lượng Swap{/bright-blue-fg}",
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  style: { fg: "bright-white", bg: "default", border: { fg: "red" } }
});

function updateWalletData() {
  const content = WALLETS.map(walletObj => 
    `Ví ${walletObj.index}: ${walletObj.wallet.address.slice(0, 10)}..${walletObj.wallet.address.slice(-3)}`
  ).join("\n");
  walletBox.setContent(`┌── Danh Sách Địa Chỉ Ví\n${content}\n└── Mạng: {bright-cyan-fg}${NETWORK_NAME}{/bright-cyan-fg}`);
  screen.render();
  addLog("Danh sách địa chỉ ví đã được cập nhật.", "system");
}

async function approveToken(walletIndex, tokenAddress, tokenAbi, amount, decimals) {
  try {
    const wallet = WALLETS[walletIndex].wallet;
    const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, wallet);
    const currentAllowance = await tokenContract.allowance(wallet.address, ROUTER_ADDRESS);
    if (currentAllowance >= amount) {
      addLog(`0G: Không cần phê duyệt, Allowance đã đủ (Ví ${WALLETS[walletIndex].index})`, "system");
      return;
    }
    const feeData = await wallet.provider.getFeeData();
    const currentGasPrice = feeData.gasPrice;
    const tx = await tokenContract.approve(ROUTER_ADDRESS, amount, {
      gasLimit: APPROVAL_GAS_LIMIT,
      gasPrice: currentGasPrice
    });
    addLog(`0G: Gửi Tx Phê Duyệt: ${shortHash(tx.hash)} (Ví ${WALLETS[walletIndex].index})`, "0g");
    await tx.wait();
    addLog(`0G: Phê duyệt thành công (Ví ${WALLETS[walletIndex].index}).`, "0g");
  } catch (error) {
    addLog(`0G: Phê duyệt thất bại (Ví ${WALLETS[walletIndex].index}): ${error.message}`, "error");
    throw error;
  }
}

async function swapAuto(walletIndex, direction, amountIn) {
  try {
    const wallet = WALLETS[walletIndex].wallet;
    const swapContract = new ethers.Contract(ROUTER_ADDRESS, CONTRACT_ABI, wallet);
    let params;
    const deadline = Math.floor(Date.now() / 1000) + 120;
    if (direction === "usdtToEth") {
      addLog(`0G: Bắt đầu Swap USDT ➯ ETH với số lượng: ${ethers.formatUnits(amountIn, 18)} USDT (Ví ${WALLETS[walletIndex].index})`, "0g");
      params = {
        tokenIn: USDT_ADDRESS,
        tokenOut: ETH_ADDRESS,
        fee: 3000,
        recipient: wallet.address,
        deadline,
        amountIn: amountIn,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0n,
      };
    } else if (direction === "ethToUsdt") {
      addLog(`0G: Bắt đầu Swap ETH ➯ USDT với số lượng: ${ethers.formatUnits(amountIn, 18)} ETH (Ví ${WALLETS[walletIndex].index})`, "0g");
      params = {
        tokenIn: ETH_ADDRESS,
        tokenOut: USDT_ADDRESS,
        fee: 3000,
        recipient: wallet.address,
        deadline,
        amountIn: amountIn,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0n,
      };
    } else if (direction === "usdtToBtc") {
      addLog(`0G: Bắt đầu Swap USDT ➯ BTC với số lượng: ${ethers.formatUnits(amountIn, 18)} USDT (Ví ${WALLETS[walletIndex].index})`, "0g");
      params = {
        tokenIn: USDT_ADDRESS,
        tokenOut: BTC_ADDRESS,
        fee: 3000,
        recipient: wallet.address,
        deadline,
        amountIn: amountIn,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0n,
      };
    } else if (direction === "btcToUsdt") {
      addLog(`0G: Bắt đầu Swap BTC ➯ USDT với số lượng: ${ethers.formatUnits(amountIn, 18)} BTC (Ví ${WALLETS[walletIndex].index})`, "0g");
      params = {
        tokenIn: BTC_ADDRESS,
        tokenOut: USDT_ADDRESS,
        fee: 3000,
        recipient: wallet.address,
        deadline,
        amountIn: amountIn,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0n,
      };
    } else if (direction === "btcToEth") {
      addLog(`0G: Bắt đầu Swap BTC ➯ ETH với số lượng: ${ethers.formatUnits(amountIn, 18)} BTC (Ví ${WALLETS[walletIndex].index})`, "0g");
      params = {
        tokenIn: BTC_ADDRESS,
        tokenOut: ETH_ADDRESS,
        fee: 3000,
        recipient: wallet.address,
        deadline,
        amountIn: amountIn,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0n,
      };
    } else if (direction === "ethToBtc") {
      addLog(`0G: Bắt đầu Swap ETH ➯ BTC với số lượng: ${ethers.formatUnits(amountIn, 18)} ETH (Ví ${WALLETS[walletIndex].index})`, "0g");
      params = {
        tokenIn: ETH_ADDRESS,
        tokenOut: BTC_ADDRESS,
        fee: 3000,
        recipient: wallet.address,
        deadline,
        amountIn: amountIn,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0n,
      };
    } else {
      throw new Error("0GSwap: Hướng swap không xác định.");
    }
    const gasPriceToUse = selectedGasPrice || (await wallet.provider.getFeeData()).gasPrice;
    const tx = await swapContract.exactInputSingle(params, {
      gasLimit: SWAP_GAS_LIMIT,
      gasPrice: gasPriceToUse
    });
    addLog(`0G: Gửi Tx Swap: ${shortHash(tx.hash)} (Ví ${WALLETS[walletIndex].index})`, "0g");
    const receipt = await tx.wait();
    addLog(`0G: Tx Swap Thành Công: ${shortHash(tx.hash)} (Ví ${WALLETS[walletIndex].index})`, "0g");
    const feeAOGI = ethers.formatEther(receipt.gasUsed * gasPriceToUse);
    addLog(`0G: Phí giao dịch: ${feeAOGI} AOGI (Ví ${WALLETS[walletIndex].index})`, "0g");
    addLog(`0GSwap: Swap ${direction} thành công (Ví ${WALLETS[walletIndex].index}).`, "0g");
  } catch (error) {
    if (error.message && error.message.toLowerCase().includes("nonce")) {
      nextNonces[walletIndex] = await WALLETS[walletIndex].wallet.provider.getTransactionCount(WALLETS[walletIndex].wallet.address, "pending");
      addLog(`Nonce được làm mới: ${nextNonces[walletIndex]} (Ví ${WALLETS[walletIndex].index})`, "system");
    }
    addLog(`0GSwap: Swap ${direction} thất bại (Ví ${WALLETS[walletIndex].index}): ${error.message}`, "error");
    throw error;
  }
}

async function autoSwapUsdtEth(walletIndex, totalSwaps) {
  try {
    for (let i = 1; i <= totalSwaps; i++) {
      if (!transactionRunning && !autoSwap24hRunning) return;
      if (i % 2 === 1) {
        try {
          const randomUsdt = (Math.random() * (300 - 100) + 100).toFixed(2);
          const usdtAmount = ethers.parseUnits(randomUsdt, 18);
          const usdtContract = new ethers.Contract(USDT_ADDRESS, USDT_ABI, WALLETS[walletIndex].wallet.provider);
          const currentUsdtBalance = await usdtContract.balanceOf(WALLETS[walletIndex].wallet.address);
          if (currentUsdtBalance < usdtAmount) {
            addLog(`0G: Số dư USDT (${ethers.formatUnits(currentUsdtBalance, 18)}) không đủ để swap USDT->ETH (Ví ${WALLETS[walletIndex].index})`, "error");
          } else {
            await addTransactionToQueue(walletIndex, async (nonce) => {
              await approveToken(walletIndex, USDT_ADDRESS, USDT_ABI, usdtAmount, 18);
              await swapAuto(walletIndex, "usdtToEth", usdtAmount);
            }, `USDT ➯ ETH, ${randomUsdt} USDT (Ví ${WALLETS[walletIndex].index})`);
          }
        } catch (error) {
          addLog(`Swap USDT ➯ ETH lỗi (Ví ${WALLETS[walletIndex].index}): ${error.message}`, "error");
        }
      } else {
        try {
          const randomEth = (Math.random() * (0.3 - 0.1) + 0.1).toFixed(6);
          const ethAmount = ethers.parseUnits(randomEth, 18);
          const ethContract = new ethers.Contract(ETH_ADDRESS, ETH_ABI, WALLETS[walletIndex].wallet.provider);
          const currentEthBalance = await ethContract.balanceOf(WALLETS[walletIndex].wallet.address);
          if (currentEthBalance < ethAmount) {
            addLog(`0G: Số dư ETH (${ethers.formatUnits(currentEthBalance, 18)}) không đủ để swap ETH->USDT (Ví ${WALLETS[walletIndex].index})`, "error");
          } else {
            await addTransactionToQueue(walletIndex, async (nonce) => {
              await approveToken(walletIndex, ETH_ADDRESS, ETH_ABI, ethAmount, 18);
              await swapAuto(walletIndex, "ethToUsdt", ethAmount);
            }, `ETH ➯ USDT, ${randomEth} ETH (Ví ${WALLETS[walletIndex].index})`);
          }
        } catch (error) {
          addLog(`0G: Swap ETH->USDT lỗi (Ví ${WALLETS[walletIndex].index}): ${error.message}`, "error");
        }
      }
      addLog(`0G: Hoàn thành Swap thứ ${i} (Ví ${WALLETS[walletIndex].index}).`, "0g");
      if (i < totalSwaps) {
        const delaySeconds = Math.floor(Math.random() * (60 - 30 + 1)) + 30;
        addLog(`0GSwap: Đợi ${delaySeconds} giây trước swap tiếp theo... (Ví ${WALLETS[walletIndex].index})`, "0g");
        await interruptibleDelay(delaySeconds * 1000);
        if (!transactionRunning && !autoSwap24hRunning) {
          addLog(`0GSwap: Tự động swap bị dừng trong thời gian chờ (Ví ${WALLETS[walletIndex].index})`, "0g");
          break;
        }
      }
    }
    addLog(`0GSwap: Hoàn thành tất cả swap USDT & ETH (Ví ${WALLETS[walletIndex].index}).`, "0g");
  } catch (error) {
    addLog(`0GSwap: Lỗi: ${error.message} (Ví ${WALLETS[walletIndex].index})`, "error");
  }
}

async function autoSwapUsdtBtc(walletIndex, totalSwaps) {
  try {
    for (let i = 1; i <= totalSwaps; i++) {
      if (!transactionRunning && !autoSwap24hRunning) return;
      if (i % 2 === 1) {
        try {
          const randomUsdt = (Math.random() * (300 - 100) + 100).toFixed(2);
          const usdtAmount = ethers.parseUnits(randomUsdt, 18);
          const usdtContract = new ethers.Contract(USDT_ADDRESS, USDT_ABI, WALLETS[walletIndex].wallet.provider);
          const currentUsdtBalance = await usdtContract.balanceOf(WALLETS[walletIndex].wallet.address);
          if (currentUsdtBalance < usdtAmount) {
            addLog(`0G: Số dư USDT (${ethers.formatUnits(currentUsdtBalance, 18)}) không đủ để swap USDT->BTC (Ví ${WALLETS[walletIndex].index})`, "error");
          } else {
            await addTransactionToQueue(walletIndex, async (nonce) => {
              await approveToken(walletIndex, USDT_ADDRESS, USDT_ABI, usdtAmount, 18);
              await swapAuto(walletIndex, "usdtToBtc", usdtAmount);
            }, `USDT ➯ BTC, ${randomUsdt} USDT (Ví ${WALLETS[walletIndex].index})`);
          }
        } catch (error) {
          addLog(`0G: Swap USDT ➯ BTC lỗi (Ví ${WALLETS[walletIndex].index}): ${error.message}`, "error");
        }
      } else {
        try {
          const randomBtc = (Math.random() * (0.05 - 0.01) + 0.01).toFixed(6);
          const btcAmount = ethers.parseUnits(randomBtc, 18);
          const btcContract = new ethers.Contract(BTC_ADDRESS, BTC_ABI, WALLETS[walletIndex].wallet.provider);
          const currentBtcBalance = await btcContract.balanceOf(WALLETS[walletIndex].wallet.address);
          if (currentBtcBalance < btcAmount) {
            addLog(`0G: Số dư BTC (${ethers.formatUnits(currentBtcBalance, 18)}) không đủ để swap BTC->USDT (Ví ${WALLETS[walletIndex].index})`, "error");
          } else {
            await addTransactionToQueue(walletIndex, async (nonce) => {
              await approveToken(walletIndex, BTC_ADDRESS, BTC_ABI, btcAmount, 18);
              await swapAuto(walletIndex, "btcToUsdt", btcAmount);
            }, `BTC ➯ USDT, ${randomBtc} BTC (Ví ${WALLETS[walletIndex].index})`);
          }
        } catch (error) {
          addLog(`0G: Swap BTC ➯ USDT lỗi (Ví ${WALLETS[walletIndex].index}): ${error.message}`, "error");
        }
      }
      addLog(`0GSwap: Hoàn thành Swap thứ ${i} (Ví ${WALLETS[walletIndex].index}).`, "0g");
      if (i < totalSwaps) {
        const delaySeconds = Math.floor(Math.random() * (60 - 30 + 1)) + 30;
        addLog(`0GSwap: Đợi ${delaySeconds} giây trước swap tiếp theo... (Ví ${WALLETS[walletIndex].index})`, "0g");
        await interruptibleDelay(delaySeconds * 1000);
        if (!transactionRunning && !autoSwap24hRunning) {
          addLog(`0GSwap: Tự động swap bị dừng trong thời gian chờ (Ví ${WALLETS[walletIndex].index})`, "0g");
          break;
        }
      }
    }
    addLog(`0GSwap: Hoàn thành tất cả swap USDT & BTC (Ví ${WALLETS[walletIndex].index}).`, "0g");
  } catch (error) {
    addLog(`0GSwap: Lỗi: ${error.message} (Ví ${WALLETS[walletIndex].index})`, "error");
  }
}

async function autoSwapBtcEth(walletIndex, totalSwaps) {
  try {
    for (let i = 1; i <= totalSwaps; i++) {
      if (!transactionRunning && !autoSwap24hRunning) return;
      if (i % 2 === 1) {
        try {
          const randomBtc = (Math.random() * (0.05 - 0.01) + 0.01).toFixed(6);
          const btcAmount = ethers.parseUnits(randomBtc, 18);
          const btcContract = new ethers.Contract(BTC_ADDRESS, BTC_ABI, WALLETS[walletIndex].wallet.provider);
          const currentBtcBalance = await btcContract.balanceOf(WALLETS[walletIndex].wallet.address);
          if (currentBtcBalance < btcAmount) {
            addLog(`0G: Số dư BTC (${ethers.formatUnits(currentBtcBalance, 18)}) không đủ để swap BTC->ETH (Ví ${WALLETS[walletIndex].index})`, "error");
          } else {
            await addTransactionToQueue(walletIndex, async (nonce) => {
              await approveToken(walletIndex, BTC_ADDRESS, BTC_ABI, btcAmount, 18);
              await swapAuto(walletIndex, "btcToEth", btcAmount);
            }, `BTC ➯ ETH, ${randomBtc} BTC (Ví ${WALLETS[walletIndex].index})`);
          }
        } catch (error) {
          addLog(`0G: Swap BTC ➯ ETH lỗi (Ví ${WALLETS[walletIndex].index}): ${error.message}`, "error");
        }
      } else {
        try {
          const randomEth = (Math.random() * (0.3 - 0.1) + 0.1).toFixed(6);
          const ethAmount = ethers.parseUnits(randomEth, 18);
          const ethContract = new ethers.Contract(ETH_ADDRESS, ETH_ABI, WALLETS[walletIndex].wallet.provider);
          const currentEthBalance = await ethContract.balanceOf(WALLETS[walletIndex].wallet.address);
          if (currentEthBalance < ethAmount) {
            addLog(`0G: Số dư ETH (${ethers.formatUnits(currentEthBalance, 18)}) không đủ để swap ETH->BTC (Ví ${WALLETS[walletIndex].index})`, "error");
          } else {
            await addTransactionToQueue(walletIndex, async (nonce) => {
              await approveToken(walletIndex, ETH_ADDRESS, ETH_ABI, ethAmount, 18);
              await swapAuto(walletIndex, "ethToBtc", ethAmount);
            }, `ETH ➯ BTC, ${randomEth} ETH (Ví ${WALLETS[walletIndex].index})`);
          }
        } catch (error) {
          addLog(`0G: Swap ETH ➯ BTC lỗi (Ví ${WALLETS[walletIndex].index}): ${error.message}`, "error");
        }
      }
      addLog(`0GSwap: Hoàn thành Swap thứ ${i} (Ví ${WALLETS[walletIndex].index}).`, "0g");
      if (i < totalSwaps) {
        const delaySeconds = Math.floor(Math.random() * (60 - 30 + 1)) + 30;
        addLog(`0GSwap: Đợi ${delaySeconds} giây trước swap tiếp theo... (Ví ${WALLETS[walletIndex].index})`, "0g");
        await interruptibleDelay(delaySeconds * 1000);
        if (!transactionRunning && !autoSwap24hRunning) {
          addLog(`0GSwap: Tự động swap bị dừng trong thời gian chờ (Ví ${WALLETS[walletIndex].index})`, "0g");
          break;
        }
      }
    }
    addLog(`0GSwap: Hoàn thành tất cả swap BTC & ETH (Ví ${WALLETS[walletIndex].index}).`, "0g");
  } catch (error) {
    addLog(`0GSwap: Lỗi: ${error.message} (Ví ${WALLETS[walletIndex].index})`, "error");
  }
}

async function autoSwapAllPairs(totalSwaps) {
  try {
    for (const walletObj of WALLETS) {
      const walletIndex = walletObj.index - 1;
      if (!transactionRunning && !autoSwap24hRunning) return;
      addLog(`0GSwap: Bắt đầu swap tất cả cặp cho Ví ${walletObj.index}`, "0g");

      await autoSwapUsdtEth(walletIndex, totalSwaps);
      if (!transactionRunning && !autoSwap24hRunning) return;

      await autoSwapUsdtBtc(walletIndex, totalSwaps);
      if (!transactionRunning && !autoSwap24hRunning) return;

      await autoSwapBtcEth(walletIndex, totalSwaps);
      if (!transactionRunning && !autoSwap24hRunning) return;

      addLog(`0GSwap: Hoàn thành tất cả cặp swap cho Ví ${walletObj.index}`, "0g");
    }
    addLog("0GSwap: Hoàn thành tất cả swap cho tất cả cặp và ví.", "0g");
  } catch (error) {
    addLog(`0GSwap: Lỗi khi swap tất cả cặp: ${error.message}`, "error");
  } finally {
    if (!autoSwap24hRunning) stopTransaction();
  }
}

function addTransactionToQueue(walletIndex, transactionFunction, description = "Giao Dịch") {
  const transactionId = ++transactionIdCounter;
  transactionQueueList.push({
    id: transactionId,
    description,
    timestamp: new Date().toLocaleTimeString(),
    status: "đang chờ",
    walletIndex: WALLETS[walletIndex].index
  });
  addLog(`Giao dịch [${transactionId}] được thêm vào hàng đợi: ${description}`, "system");
  updateQueueDisplay();
  transactionQueue = transactionQueue.then(async () => {
    updateTransactionStatus(transactionId, "đang xử lý");
    addLog(`Giao dịch [${transactionId}] bắt đầu xử lý (Ví ${WALLETS[walletIndex].index}).`, "system");
    try {
      if (nextNonces[walletIndex] === null) {
        nextNonces[walletIndex] = await WALLETS[walletIndex].wallet.provider.getTransactionCount(WALLETS[walletIndex].wallet.address, "pending");
        addLog(`Nonce ban đầu: ${nextNonces[walletIndex]} (Ví ${WALLETS[walletIndex].index})`, "system");
      }
      const result = await transactionFunction(nextNonces[walletIndex]);
      nextNonces[walletIndex]++;
      updateTransactionStatus(transactionId, "hoàn thành");
      addLog(`Giao dịch [${transactionId}] hoàn thành (Ví ${WALLETS[walletIndex].index}).`, "system");
      return result;
    } catch (error) {
      if (error.message && error.message.toLowerCase().includes("nonce")) {
        nextNonces[walletIndex] = await WALLETS[walletIndex].wallet.provider.getTransactionCount(WALLETS[walletIndex].wallet.address, "pending");
        addLog(`Nonce được làm mới: ${nextNonces[walletIndex]} (Ví ${WALLETS[walletIndex].index})`, "system");
      }
      updateTransactionStatus(transactionId, "lỗi");
      addLog(`Giao dịch [${transactionId}] thất bại (Ví ${WALLETS[walletIndex].index}): ${error.message}`, "system");
    } finally {
      removeTransactionFromQueue(transactionId);
      updateQueueDisplay();
    }
  });
  return transactionQueue;
}

function updateTransactionStatus(id, status) {
  transactionQueueList.forEach(tx => {
    if (tx.id === id) tx.status = status;
  });
  updateQueueDisplay();
}

function removeTransactionFromQueue(id) {
  transactionQueueList = transactionQueueList.filter(tx => tx.id !== id);
  updateQueueDisplay();
}

function getTransactionQueueContent() {
  if (transactionQueueList.length === 0) return "Không có giao dịch nào trong hàng đợi.";
  return transactionQueueList.map(tx => `ID: ${tx.id} | ${tx.description} | ${tx.status} | ${tx.timestamp}`).join("\n");
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
  autoSwap24hRunning = false;
  if (autoSwap24hInterval) clearInterval(autoSwap24hInterval);
  autoSwap24hInterval = null;
  nextSwapTime = null;
  chosenSwap = null;
  updateMainMenuItems();
  update0gSwapSubMenuItems();
  updateCountdownBox();
  screen.render();
}

function stopAllTransactions() {
  if (transactionRunning || autoSwap24hRunning) {
    stopTransaction();
    addLog("Nhận lệnh Dừng Tất Cả Giao Dịch. Tất cả giao dịch đã bị dừng.", "system");
  } else {
    addLog("Không có giao dịch nào đang chạy.", "system");
  }
}

async function startTransactionProcess(pair, totalSwaps) {
  await chooseGasFee().then(async gasPrice => {
    selectedGasPrice = gasPrice;
    addLog(`Phí gas được chọn: ${ethers.formatUnits(selectedGasPrice, "gwei")} Gwei`, "system");
    transactionRunning = true;
    chosenSwap = pair;
    updateMainMenuItems();
    update0gSwapSubMenuItems();
    addLog(`Bắt đầu ${pair} ${totalSwaps} lần cho tất cả ví...`, "0g");

    if (pair === "USDT & ETH") {
      for (const walletObj of WALLETS) {
        if (!transactionRunning) break;
        await autoSwapUsdtEth(walletObj.index - 1, totalSwaps);
      }
    } else if (pair === "USDT & BTC") {
      for (const walletObj of WALLETS) {
        if (!transactionRunning) break;
        await autoSwapUsdtBtc(walletObj.index - 1, totalSwaps);
      }
    } else if (pair === "BTC & ETH") {
      for (const walletObj of WALLETS) {
        if (!transactionRunning) break;
        await autoSwapBtcEth(walletObj.index - 1, totalSwaps);
      }
    } else if (pair === "Tất Cả Cặp") {
      await autoSwapAllPairs(totalSwaps);
    } else {
      addLog(`Logic swap cho cặp ${pair} chưa được triển khai.`, "error");
      stopTransaction();
    }
  }).catch(err => {
    addLog("Hủy chọn phí gas: " + err, "system");
  });
}

async function startAutoSwap24h(totalSwaps) {
  await chooseGasFee().then(async gasPrice => {
    selectedGasPrice = gasPrice;
    addLog(`Phí gas được chọn: ${ethers.formatUnits(selectedGasPrice, "gwei")} Gwei`, "system");
    autoSwap24hRunning = true;
    updateMainMenuItems();
    update0gSwapSubMenuItems();
    addLog(`Bắt đầu tự động swap tất cả cặp mỗi 24h với ${totalSwaps} lần swap mỗi lần...`, "0g");

    const runSwap = async () => {
      if (!autoSwap24hRunning) return;
      addLog("Tự động swap 24h: Bắt đầu chu kỳ swap mới.", "0g");
      await autoSwapAllPairs(totalSwaps);
      if (autoSwap24hRunning) {
        nextSwapTime = Date.now() + 24 * 60 * 60 * 1000; // Cập nhật thời điểm swap tiếp theo
        addLog("Tự động swap 24h: Hoàn thành chu kỳ swap, đợi 24h tiếp theo.", "0g");
      }
    };

    // Chạy lần đầu ngay lập tức
    await runSwap();
    nextSwapTime = Date.now() + 24 * 60 * 60 * 1000; // Thời điểm swap tiếp theo sau 24h

    // Lập lịch chạy mỗi 24h
    autoSwap24hInterval = setInterval(async () => {
      await runSwap();
    }, 24 * 60 * 60 * 1000); // 24 giờ

  }).catch(err => {
    addLog("Hủy chọn phí gas cho swap 24h: " + err, "system");
    stopTransaction();
  });
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
      tags: true,
    });
    container.append(gasFeeList);

    const cancelButton = blessed.button({
      content: 'Hủy',
      bottom: 0,
      left: 'center',
      shrink: true,
      padding: { left: 1, right: 1 },
      border: { type: 'line' },
      style: {
        fg: 'white',
        bg: 'red',
        border: { fg: 'white' },
        hover: { bg: 'blue' }
      },
      mouse: true,
      keys: true,
      tags: true,
    });
    cancelButton.on('press', () => {
      container.destroy();
      autoSwapSubMenu.focus();
      screen.render();
    });
    container.append(cancelButton);

    screen.append(container);
    gasFeeList.focus();
    screen.render();

    gasFeeList.on('select', (item, index) => {
      container.destroy();
      WALLETS[0].wallet.provider.getFeeData().then((feeData) => {
        const gasPriceBN = feeData.gasPrice;
        if (index === 0) {
          resolve(gasPriceBN);
        } else if (index === 1) {
          resolve(gasPriceBN * 80n / 100n);
        } else if (index === 2) {
          resolve(gasPriceBN * 2n);
        }
        autoSwapSubMenu.focus();
        screen.render();
      }).catch(reject);
    });
  });
}

mainMenu.on("select", (item) => {
  const selected = item.getText();
  if (selected === "Swap 0g") {
    mainMenu.hide();
    autoSwapSubMenu.show();
    autoSwapSubMenu.focus();
    screen.render();
  } else if (selected === "Hàng Đợi Giao Dịch") {
    showTransactionQueueMenu();
  } else if (selected === "Dừng Tất Cả Giao Dịch") {
    stopAllTransactions();
  } else if (selected === "Xóa Nhật Ký Giao Dịch") {
    logsBox.setContent("");
    clearTransactionLogs();
  } else if (selected === "Làm Mới") {
    updateWalletData();
  } else if (selected === "Thoát") {
    process.exit(0);
  }
});

autoSwapSubMenu.on("select", (item) => {
  const selected = item.getText();
  if ((transactionRunning || autoSwap24hRunning) && !["Dừng Giao Dịch", "Xóa Nhật Ký Giao Dịch", "Quay Lại Menu Chính", "Thoát"].includes(selected)) {
    addLog("Đang có giao dịch chạy. Vui lòng dừng giao dịch trước.", "system");
    return;
  }
  if (selected.startsWith("Tự Động Swap USDT & ETH")) {
    promptBox.setLabel("{bright-blue-fg}Số Lượng Swap (USDT & ETH){/bright-blue-fg}");
    promptBox.setFront();
    promptBox.readInput("Nhập số lượng swap:", "", async (err, value) => {
      promptBox.hide();
      screen.render();
      if (err || !value) {
        addLog("Hủy nhập số lượng swap.", "system");
        return;
      }
      const totalSwaps = parseInt(value);
      if (isNaN(totalSwaps) || totalSwaps <= 0) {
        addLog("Số lượng swap không hợp lệ. Nhập số > 0.", "error");
        return;
      }
      await startTransactionProcess("USDT & ETH", totalSwaps);
    });
  } else if (selected.startsWith("Tự Động Swap USDT & BTC")) {
    promptBox.setLabel("{bright-blue-fg}Số Lượng Swap (USDT & BTC){/bright-blue-fg}");
    promptBox.setFront();
    promptBox.readInput("Nhập số lượng swap:", "", async (err, value) => {
      promptBox.hide();
      screen.render();
      if (err || !value) {
        addLog("Hủy nhập số lượng swap.", "system");
        return;
      }
      const totalSwaps = parseInt(value);
      if (isNaN(totalSwaps) || totalSwaps <= 0) {
        addLog("Số lượng swap không hợp lệ. Nhập số > 0.", "error");
        return;
      }
      await startTransactionProcess("USDT & BTC", totalSwaps);
    });
  } else if (selected.startsWith("Tự Động Swap BTC & ETH")) {
    promptBox.setLabel("{bright-blue-fg}Số Lượng Swap (BTC & ETH){/bright-blue-fg}");
    promptBox.setFront();
    promptBox.readInput("Nhập số lượng swap:", "", async (err, value) => {
      promptBox.hide();
      screen.render();
      if (err || !value) {
        addLog("Hủy nhập số lượng swap.", "system");
        return;
      }
      const totalSwaps = parseInt(value);
      if (isNaN(totalSwaps) || totalSwaps <= 0) {
        addLog("Số lượng swap không hợp lệ. Nhập số > 0.", "error");
        return;
      }
      await startTransactionProcess("BTC & ETH", totalSwaps);
    });
  } else if (selected.startsWith("Tự Động Swap Tất Cả Cặp")) {
    promptBox.setLabel("{bright-blue-fg}Số Lượng Swap (Tất Cả Cặp){/bright-blue-fg}");
    promptBox.setFront();
    promptBox.readInput("Nhập số lượng swap:", "", async (err, value) => {
      promptBox.hide();
      screen.render();
      if (err || !value) {
        addLog("Hủy nhập số lượng swap.", "system");
        return;
      }
      const totalSwaps = parseInt(value);
      if (isNaN(totalSwaps) || totalSwaps <= 0) {
        addLog("Số lượng swap không hợp lệ. Nhập số > 0.", "error");
        return;
      }
      await startTransactionProcess("Tất Cả Cặp", totalSwaps);
    });
  } else if (selected.startsWith("Tự Động Swap 24h")) {
    promptBox.setLabel("{bright-blue-fg}Số Lượng Swap (24h){/bright-blue-fg}");
    promptBox.setFront();
    promptBox.readInput("Nhập số lượng swap mỗi 24h:", "", async (err, value) => {
      promptBox.hide();
      screen.render();
      if (err || !value) {
        addLog("Hủy nhập số lượng swap 24h.", "system");
        return;
      }
      const totalSwaps = parseInt(value);
      if (isNaN(totalSwaps) || totalSwaps <= 0) {
        addLog("Số lượng swap không hợp lệ. Nhập số > 0.", "error");
        return;
      }
      await startAutoSwap24h(totalSwaps);
    });
  } else if (selected === "Dừng Giao Dịch") {
    stopTransaction();
  } else if (selected === "Xóa Nhật Ký Giao Dịch") {
    logsBox.setContent("");
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

screen.append(headerBox);
screen.append(descriptionBox);
screen.append(logsBox);
screen.append(gasPriceBox);
screen.append(walletBox);
screen.append(countdownBox);
screen.append(mainMenu);
screen.append(autoSwapSubMenu);
screen.append(queueMenu);

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
  gasPriceBox.height = Math.floor(screenHeight * 0.15);
  countdownBox.top = gasPriceBox.top + gasPriceBox.height;
  countdownBox.left = logsBox.left;
  countdownBox.width = logsBox.width;
  countdownBox.height = Math.floor(screenHeight * 0.07);
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

screen.on("resize", () => {
  adjustLayout();
  screen.render();
});
adjustLayout();

screen.key(["escape", "q", "C-c"], () => process.exit(0));

mainMenu.focus();
updateWalletData();
updateMainMenuItems();
update0gSwapSubMenuItems();
screen.render();
