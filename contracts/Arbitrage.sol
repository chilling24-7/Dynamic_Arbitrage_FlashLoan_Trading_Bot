// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

import "@balancer-labs/v2-interfaces/contracts/vault/IVault.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IFlashLoanRecipient.sol";
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

interface ICurvePool {
    function exchange(
        int128 i,
        int128 j,
        uint256 dx,
        uint256 min_dy
    ) external returns (uint256);
}

contract Arbitrage is IFlashLoanRecipient, ReentrancyGuard, Pausable {

    struct SwapStep {
    uint8 dex;        // 0 = Uniswap V3
    address tokenIn;
    address tokenOut;
    uint24 fee;       // Uniswap V3 fee tier
}

    // --- STATE ---
    IVault public vault;
    ISwapRouter public immutable uniRouter;
    ICurvePool public immutable curvePool;
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

    modifier onlyOwner() {
        require(msg.sender == owner, "Not authorized");
        _;
    }

    modifier onlyWhitelisted() {
        require(msg.sender == owner || whitelistedAddresses[msg.sender], "Not authorized");
        _;
    }

    constructor(
        address _uniRouter,
        address _curvePool,
        address _vault
    ) {
        require(_uniRouter != address(0), "Invalid Uni router");
        require(_curvePool != address(0), "Invalid Curve pool");

        uniRouter = ISwapRouter(_uniRouter);
        curvePool = ICurvePool(_curvePool);

        vault = _vault == address(0)
            ? IVault(0xBA12222222228d8Ba445958a75a0704d566BF2C8)
            : IVault(_vault);

        owner = msg.sender;
    }

    // --- ERC20 HELPERS ---
    function safeApprove(IERC20 token, address spender, uint256 amount) internal {
        (bool success, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.approve.selector, spender, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "Approve failed");
    }

    function safeTransfer(IERC20 token, address to, uint256 amount) internal {
        (bool success, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.transfer.selector, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "Transfer failed");
    }

    // --- UNISWAP V3 SWAP ---

    function _swapOnUniswap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint24 fee
    ) internal returns (uint256 amountOut) {

        emit LogError("Before Uniswap swap");

        ISwapRouter.ExactInputSingleParams memory params =
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                deadline: block.timestamp + 1200,
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            });
        emit SwapExecuted(
            tokenIn,
            tokenOut,
            amountIn,
            fee
        );

        try uniRouter.exactInputSingle(params) returns (uint256 result) {
            amountOut = result;
        } catch {
            revert("UNISWAP SWAP FAILED");
        }

        require(amountOut > 0, "UNI RETURNED ZERO");

        emit LogError("After Uniswap swap");

        emit SwapExecuted(
            tokenIn,
            tokenOut,
            amountIn,
            amountOut
        );
    }


    // --- CURVE SWAP ---
    function _swapOnCurve(
        int128 i,
        int128 j,
        uint256 amountIn,
        uint256 minOut
    ) internal returns (uint256 amountOut) {

        amountOut = curvePool.exchange(i, j, amountIn, minOut);

        emit SwapExecuted(address(0), address(0), amountIn, amountOut);
    }

    // --- EXECUTE TRADE ---
    function executeTrade(
        address tokenIn,
        uint256 flashAmount,
        SwapStep[] calldata route,
        uint256 minProfit
    ) external nonReentrant onlyWhitelisted whenNotPaused {

        require(route.length > 0, "Empty route");

        // flash token must match route start
        require(tokenIn == route[0].tokenIn, "Flash token mismatch");

        // must be closed loop (start = end)
        require(route[route.length - 1].tokenOut == tokenIn, "Route must end in flash token");

        bytes memory data = abi.encode(route, minProfit);

        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(tokenIn);

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = flashAmount;

        vault.flashLoan(this, tokens, amounts, data);
    }

    // --- FLASH LOAN CALLBACK ---
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {

        require(msg.sender == address(vault), "Unauthorized flash loan");

        (SwapStep[] memory route, uint256 minProfit) =
            abi.decode(userData, (SwapStep[], uint256));

        address baseToken = address(tokens[0]);

        uint256 amountIn = amounts[0];
        uint256 repay = amountIn + feeAmounts[0];

        require(route.length > 0, "Empty route");
        require(route[0].tokenIn == baseToken, "Bad route start");
        require(route[route.length - 1].tokenOut == baseToken, "Must end in flash token");

        uint256 expectedTokenBalance = amountIn;
        address expectedToken = baseToken;

        // ============================
        // EXECUTE MULTI-HOP ROUTE
        // ============================
        for (uint256 i = 0; i < route.length; i++) {

            SwapStep memory step = route[i];

            require(step.tokenIn == expectedToken, "Broken route continuity");
            require(step.tokenIn != address(0), "Bad tokenIn");
            require(step.tokenOut != address(0), "Bad tokenOut");

            expectedToken = step.tokenOut;

            if (step.dex == 0) {

                // FIXED APPROVAL PATTERN (IMPORTANT)
                safeApprove(IERC20(step.tokenIn), address(uniRouter), 0);
                safeApprove(IERC20(step.tokenIn), address(uniRouter), expectedTokenBalance);

                expectedTokenBalance = _swapOnUniswap(
                    step.tokenIn,
                    step.tokenOut,
                    expectedTokenBalance,
                    0,
                    step.fee
                );

            } else {
                revert("Unsupported DEX");
            }
        }

        // ============================
        // FINAL REAL BALANCE CHECK
        // ============================
        uint256 finalBalance = IERC20(baseToken).balanceOf(address(this));

        require(finalBalance >= repay, "Cannot repay loan");

        uint256 profit = finalBalance - repay;
        require(profit >= minProfit, "No profit");

        // repay flash loan
        safeTransfer(IERC20(baseToken), address(vault), repay);

        // send profit
        if (profit > 0) {
            safeTransfer(IERC20(baseToken), owner, profit);
        }

        emit FlashLoanExecuted(baseToken, amountIn);
        emit FlashLoanRepayment(baseToken, repay);
        emit Profit(profit);
    }
}