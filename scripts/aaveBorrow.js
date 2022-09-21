const { ethers, getNamedAccounts, network } = require("hardhat")
const { getWeth, AMOUNT } = require("../scripts/getWeth.js")
const { networkConfig } = require("../helper-hardhat-config")

const swapRouterContractName =
    //"ISwapRouter", //V2
    "ISwapRouter02" //V3
const swapRouterAddress =
    //"0xE592427A0AEce92De3Edee1F18E0157C05861564", //V2
    "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" //V3

async function main() {
    await getWeth()
    const { deployer } = await getNamedAccounts()
    const wethTokenAddress = networkConfig[network.config.chainId].wethToken
    const daiTokenAddress = networkConfig[network.config.chainId].daiToken
    const iDai = await ethers.getContractAt("ISERC20", daiTokenAddress, deployer)
    const iWeth = await ethers.getContractAt("ISERC20", wethTokenAddress, deployer)

    const lendingPool = await getLendingPool(deployer)
    console.log(`LendingPool address ${lendingPool.address}`)

    console.log("===================")
    console.log("DEPOSITING WETH ...")
    console.log("===================")
    console.log(`Approving WETH WEI Deposit of ${AMOUNT} ...`)
    await approveErc20(iWeth, lendingPool.address, AMOUNT)
    console.log(`Depositing ${AMOUNT} WETH WEI ...`)
    await lendingPool.deposit(wethTokenAddress, AMOUNT, deployer, 0)
    console.log("Deposited!")

    console.log("==================")
    console.log("TIME TO BORROW ...")
    console.log("==================")
    // Getting your borrowing stats
    let borrowedData = await getBorrowedUserData(lendingPool, deployer, iWeth, iDai)
    const daiPriceWei = await getDaiPrice()
    const amountDaiToBorrow =
        borrowedData.availableBorrowsETH.toString() * 0.95 * (1 / daiPriceWei.toNumber())
    const amountDaiToBorrowWei = ethers.utils.parseEther(amountDaiToBorrow.toString())
    console.log(`You can borrow ${amountDaiToBorrow.toString()} DAI`)

    await borrowDai(
        networkConfig[network.config.chainId].daiToken,
        lendingPool,
        amountDaiToBorrowWei,
        deployer
    )
    borrowedData = await getBorrowedUserData(lendingPool, deployer, iWeth, iDai)

    console.log("=================")
    console.log("REPAYING LOAN ...")
    console.log("=================")

    await repay(
        amountDaiToBorrowWei,
        iDai,
        networkConfig[network.config.chainId].daiToken,
        lendingPool,
        deployer
    )
    // Tiny amount of totalDebtETH still left over because interest is accured
    // and you need to pay more to account for interest
    // https://app.uniswap.org/#/swap
    // Swap ETH for DAI to repay the debt
    borrowedData = await getBorrowedUserData(lendingPool, deployer, iWeth, iDai)

    const amountDaiAccruedToRepayWei = ethers.utils.parseEther(
        (borrowedData.totalDebtETH.toString() * 1 * (1 / daiPriceWei)).toFixed(18).toString()
    )
    // Pay back upto 2x the amount
    const amountWethAccruedToRepayWei = (borrowedData.totalDebtETH.toString() * 2).toString()

    console.log(`You have accrued ${amountDaiAccruedToRepayWei} DAI WEI in Interest to Repay`)
    console.log(
        `You have accrued ${ethers.utils.formatUnits(
            amountDaiAccruedToRepayWei,
            18
        )} DAI in Interest to Repay`
    )
    console.log(`You have accrued ${amountWethAccruedToRepayWei} WETH WEI to Repay (x2 required)`)
    console.log(
        `You have accrued ${ethers.utils.formatUnits(
            amountWethAccruedToRepayWei,
            18
        )} WETH in Interest to Repay (x2 required)`
    )

    console.log("=============================")
    console.log("REPAYING ACCRUED INTEREST ...")
    console.log("=============================")
    console.log(`Withdrawing ${amountWethAccruedToRepayWei} WETH WEI from LendingPool to Wallet`)
    await withdrawWeth(lendingPool, amountWethAccruedToRepayWei, deployer, iWeth)

    console.log("--------- SWAPPING WETH for DAI ---------")
    await swapWethToDai(
        amountDaiAccruedToRepayWei,
        amountWethAccruedToRepayWei,
        iWeth,
        iDai,
        deployer
    )
    console.log("--------- SWAPPED WETH for DAI ---------")

    // Then repay the rest of the accrued interest
    await repay(amountDaiAccruedToRepayWei, iDai, daiTokenAddress, lendingPool, deployer)
    borrowedData = await getBorrowedUserData(lendingPool, deployer, iWeth, iDai)
}

async function repay(amountInWei, erc20token, tokenAddress, lendingPool, account) {
    console.log("Approving RePay ...")
    await approveErc20(erc20token, lendingPool.address, amountInWei)
    const repayTx = await lendingPool.repay(tokenAddress, amountInWei, 1, account)
    await repayTx.wait(1)
    console.log("You've Repaid!")
}

async function borrowDai(daiAddress, lendingPool, amountDaiToBorrow, account) {
    const borrowTx = await lendingPool.borrow(daiAddress, amountDaiToBorrow, 1, 0, account)
    await borrowTx.wait(1)
    console.log("You've borrowed!")
}

async function withdrawWeth(lendingPool, amountWethToWithdrawWei, account, iWeth) {
    const withdrawTx = await lendingPool.withdraw(iWeth.address, amountWethToWithdrawWei, account)
    withdrawTx.wait(1)
    console.log("You've withdrawan!")
    const wethBalance = await iWeth.balanceOf(account)
    console.log(`Got ${ethers.utils.formatUnits(wethBalance.toString(), "ether")} WETH in Wallet`)
}

async function getDaiPrice() {
    const daiEthPriceFeed = await ethers.getContractAt(
        "AggregatorV3Interface",
        networkConfig[network.config.chainId].daiEthPriceFeed
    )
    const price = (await daiEthPriceFeed.latestRoundData())[1]
    console.log(`The ETH/DAI price is ${price.toString()}`)
    return price
}

async function approveErc20(erc20Token, spenderAddress, amount) {
    const txResponse = await erc20Token.approve(spenderAddress, amount)
    await txResponse.wait(1)
    console.log("Approved ERC20!")
}

async function getLendingPool(account) {
    const lendingPoolAddressesProvider = await ethers.getContractAt(
        "ILendingPoolAddressesProvider",
        networkConfig[network.config.chainId].lendingPoolAddressesProvider,
        account
    )
    const lendingPoolAddress = await lendingPoolAddressesProvider.getLendingPool()
    const lendingPool = await ethers.getContractAt("ILendingPool", lendingPoolAddress, account)
    return lendingPool
}

async function getBorrowedUserData(lendingPool, account, iWeth, iDai) {
    const borrowedData = await lendingPool.getUserAccountData(account)
    console.log(`You have ${borrowedData.totalCollateralETH} worth of ETH deposited.`)
    console.log(`You have ${borrowedData.totalDebtETH} worth of ETH borrowed.`)
    console.log(`You can borrow ${borrowedData.availableBorrowsETH} worth of ETH.`)

    const wethBalance = await iWeth.balanceOf(account)
    console.log(`Got ${ethers.utils.formatUnits(wethBalance.toString(), 18)} WETH in Wallet`)
    const daiBalance = await iDai.balanceOf(account)
    console.log(`Got ${ethers.utils.formatUnits(daiBalance.toString(), 18)} DAI in Wallet`)

    return borrowedData
}

async function swapWethToDai(
    amountDaiAccruedToRepayWei,
    withdrawnWETHAmountWei,
    iWeth,
    iDai,
    account
) {
    const SwapDaiContract = await ethers.getContractFactory("SwapDAI")
    const swapRouterContract = await ethers.getContractAt(
        swapRouterContractName,
        swapRouterAddress,
        account
    )
    console.log(`SwapRouter created at ${swapRouterContract.address}`)
    const swapDai = await SwapDaiContract.deploy(swapRouterContract.address)
    await swapDai.deployed()
    console.log(`SwapDAI deployed at ${swapDai.address}`)

    console.log(withdrawnWETHAmountWei, " WETH WEI used to Swap for DAI: ")
    console.log("Approving Swapping from iWeth -> iDai ...")
    console.log(`Approve ${withdrawnWETHAmountWei} WETH WEI to SwapRouter`)
    await approveErc20(iWeth, swapRouterContract.address, withdrawnWETHAmountWei) //amountWethAccruedToRepayWei)
    console.log(`Approve ${withdrawnWETHAmountWei} WETH WEI to SwapDai`)
    await approveErc20(iWeth, swapDai.address, withdrawnWETHAmountWei) //amountWethAccruedToRepayWei)

    const swapTx = await swapDai.swapExactOutputSingle(
        amountDaiAccruedToRepayWei, // OUT
        withdrawnWETHAmountWei //IN
    )
    swapTx.wait(1)
    const wethBalance = await iWeth.balanceOf(account)
    console.log(`Got ${ethers.utils.formatUnits(wethBalance.toString(), 18)} WETH in Wallet`)
    const daiBalance = await iDai.balanceOf(account)
    console.log(`Got ${ethers.utils.formatUnits(daiBalance.toString(), 18)} DAI in Wallet`)
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error)
        process.exit(1)
    })
