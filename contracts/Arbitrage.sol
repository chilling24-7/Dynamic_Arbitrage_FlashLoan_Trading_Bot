// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "@balancer-labs/v2-interfaces/contracts/vault/IVault.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IFlashLoanRecipient.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

contract Arbitrage is IFlashLoanRecipient, ReentrancyGuard, Pausable {
    // --- STATE VARIABLES ---
    IVault public vault;
    IUniswapV2Router02 public immutable sRouter;
    IUniswapV2Router02 public immutable uRouter;
    address public owner;

    uint256 public flashLoanExecutionCount;
    uint256 public constant MAX_FLASH_LOAN_EXECUTIONS = 1;

    mapping(address => bool) public whitelistedAddresses;

    // --- EVENTS ---
    event LogError(string message);
    event FlashLoanExecuted(address token, uint256 amount);
    event SwapExecuted(address fromToken, address toToken, uint256 amountIn, uint256 amountOut);
    event FlashLoanRepayment(address token, uint256 amount);
    event Profit(uint256 amount);
    event ApprovalSuccess(address token, address spender, uint256 amount);

    event TokenBalance(address indexed token, uint256 balance);
    event FlashLoanStepCompleted(address token, uint256 totalRepaymentAmount, uint256 finalBalance);

    // --- MODIFIERS ---
    modifier onlyOwner() {
        require(msg.sender == owner, "Not authorized");
        _;
    }

    modifier onlyWhitelisted() {
        require(msg.sender == owner || whitelistedAddresses[msg.sender], "Not authorized");
        _;
    }

    // --- CONSTRUCTOR ---
    constructor(address _sRouter, address _uRouter, address _vault) {
        sRouter = IUniswapV2Router02(_sRouter);
        uRouter = IUniswapV2Router02(_uRouter);

        // 🔥 Key logic
        if (_vault == address(0)) {
            vault = IVault(0xBA12222222228d8Ba445958a75a0704d566BF2C8); // mainnet default
        } else {
            vault = IVault(_vault); // test/mock vault
        }

        owner = msg.sender;
    }

    // --- OWNER FUNCTIONS ---
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function addToWhitelist(address _address) external onlyOwner {
        whitelistedAddresses[_address] = true;
    }

    function removeFromWhitelist(address _address) external onlyOwner {
        whitelistedAddresses[_address] = false;
    }

    function setVault(address _vault) external onlyOwner {
        require(_vault != address(0), "Invalid vault");
        vault = IVault(_vault);
    }

    // --- ERC20 HELPERS ---
    function safeTransfer(IERC20 token, address to, uint256 amount) internal {
        (bool success, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.transfer.selector, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "Transfer failed");
    }

    function safeApprove(IERC20 token, address spender, uint256 amount) internal {
        (bool success, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.approve.selector, spender, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "Approve failed");
        emit ApprovalSuccess(address(token), spender, amount);
    }

    function getDecimals(address token) internal view returns (uint8) {
        (bool success, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("decimals()")
        );
        require(success, "Failed to get decimals");
        return abi.decode(data, (uint8));
    }

    function executeTrade(
        bool _startOnUniswap,
        address _token0,
        address _token1,
        address _token2,
        uint256 _flashAmount,
        uint256 _minProfit,
        uint256 _slippageBps
    ) external nonReentrant onlyWhitelisted whenNotPaused {
        emit LogError("Start trade");
        bytes memory data = abi.encode(_startOnUniswap, _token0, _token1, _token2, _minProfit, _slippageBps);

        // Token to flash loan, by default we are flash loaning 1 token.
        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(_token0);

        // Flash loan amount.
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = _flashAmount;

        vault.flashLoan(this, tokens, amounts, data);
        emit LogError("Trade executed successfully");
    }

    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        require(msg.sender == address(vault), "Unauthorized flash loan provider");

        // --- EXECUTION COUNTER ---
        require(flashLoanExecutionCount < MAX_FLASH_LOAN_EXECUTIONS, "Max flash loan executions reached");
        flashLoanExecutionCount++;

        (bool startOnUniswap, address token0, address token1, address token2, uint256 _minProfit, uint256 slippageBps) = abi.decode(
            userData, (bool, address, address, address, uint256, uint256));

        uint256 flashAmount = amounts[0];
        uint256 flashLoanFee = feeAmounts[0];
        uint256 totalRepaymentAmount = flashAmount + flashLoanFee;

        emit FlashLoanExecuted(token0, flashAmount);

        // --- FORWARD TRADE PATH ---
        address[] memory path;
        if (token2 == address(0)) {
            path = new address [] (2);
            path[0] = token0;
            path[1] = token1;
        } else {
            path = new address [] (3);
            path[0] = token0;
            path[1] = token1;
            path[2] = token2;
        }

        // --- APPROVE TOKENS BEFORE FORWARD SWAP ---
        safeApprove(IERC20(path[0]), startOnUniswap ? address(uRouter) : address(sRouter), type(uint256).max);
        emit TokenBalance(path[0], IERC20(path[0]).balanceOf(address(this)));

        // --- EXECUTE FORWARD SWAP ---
        uint256 received = startOnUniswap
            ? _swapOnUniswap(path, flashAmount, slippageBps)
            : _swapOnSushiswap(path, flashAmount, slippageBps);

        // --- LOG BALANCES AFTER FORWARD SWAP ---
        emit TokenBalance(token0, IERC20(token0).balanceOf(address(this)));
        if (token2 != address(0)) {
            emit TokenBalance(token2, IERC20(token2).balanceOf(address(this)));
        }
        emit SwapExecuted(path[0], path[path.length - 1], flashAmount, received);

        // --- RETURN TRADE PATH ---
        address[] memory returnPath;
        if (token2 == address(0)) {
            returnPath = new address [] (2);
            returnPath[0] = token1;
            returnPath[1] = token0;
        } else {
            returnPath = new address [] (3);
            returnPath[0] = token2;
            returnPath[1] = token1;
            returnPath[2] = token0;
        }

        uint256 returnAmount = token2 == address(0)
            ? IERC20(token1).balanceOf(address(this))
            : IERC20(token2).balanceOf(address(this));

        // --- APPROVE TOKENS BEFORE RETURN SWAP ---
        for (uint i = 0; i < returnPath.length - 1; i++) {
            safeApprove(IERC20(returnPath[i]), startOnUniswap ? address(sRouter) : address(uRouter), type(uint256).max);
            emit TokenBalance(returnPath[i], IERC20(returnPath[i]).balanceOf(address(this)));
        }

        // --- EXECUTE RETURN SWAP ---
        uint256 receivedBack = startOnUniswap
            ? _swapOnSushiswap(returnPath, returnAmount, slippageBps)
            : _swapOnUniswap(returnPath, returnAmount, slippageBps);

        // --- LOG FINAL BALANCES ---
        uint256 finalBalance = IERC20(token0).balanceOf(address(this));
        emit TokenBalance(token0, finalBalance);
        emit FlashLoanStepCompleted(token0, totalRepaymentAmount, finalBalance);

        // --- ENSURE WE CAN REPAY ---
        require(finalBalance >= totalRepaymentAmount, "Not enough to repay loan");

        // --- CALCULATE PROFIT ---
        uint256 profit = finalBalance - totalRepaymentAmount;

        // ✅ Gas / profit protection
        require(profit >= _minProfit, "Profit below threshold (gas protection)");

        // --- REPAY FLASH LOAN ---
        safeTransfer(IERC20(token0), address(vault), totalRepaymentAmount);

        // --- SEND PROFIT TO OWNER ---
        if (profit > 0) {
            safeTransfer(IERC20(token0), owner, profit);
        }

        emit FlashLoanRepayment(token0, totalRepaymentAmount);
        emit Profit(profit);

        // --- RESET COUNTER ---
        flashLoanExecutionCount = 0;
    }

    // --- INTERNAL SWAP HELPERS ---
    function _swapOnUniswap(address[] memory _path, uint256 _amountIn, uint256 _slippageBps) internal returns (uint256) {

    uint256 amountOut;
    uint256[] memory amountsOut = uRouter.getAmountsOut(_amountIn, _path);
    uint256 slippageBps = _slippageBps;
    uint256 amountOutMin = (amountsOut[amountsOut.length - 1] * (10000 - slippageBps)) / 10000;

    try uRouter.swapExactTokensForTokens(
        _amountIn,
        amountOutMin,
        _path,
        address(this),
        block.timestamp + 1200
    ) returns (uint256[] memory swapped) {
        amountOut = swapped[swapped.length - 1];
    } catch {
        revert("Swap failed");
    }

    return amountOut;
}

    function _swapOnSushiswap(address[] memory _path, uint256 _amountIn, uint256 _slippageBps) internal returns (uint256) {
    uint256 amountOut;
    uint256[] memory amountsOut = sRouter.getAmountsOut(_amountIn, _path);
    uint256 amountOutMin = (amountsOut[amountsOut.length - 1] * (10000 - _slippageBps)) / 10000;

    try sRouter.swapExactTokensForTokens(
        _amountIn,
        amountOutMin,
        _path,
        address(this),
        block.timestamp + 1200
    ) returns (uint256[] memory swapped) {
        amountOut = swapped[swapped.length - 1];
    } catch {
        revert("Swap failed");
    }

    return amountOut;
}
}