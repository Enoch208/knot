pragma solidity 0.8.28;

contract UncheckedPayout {
    address public immutable owner;
    uint256 public attemptedPayments;

    constructor() {
        owner = msg.sender;
    }

    function pay(address target, bytes calldata data) external {
        require(msg.sender == owner, "owner");
        target.call(data);
        attemptedPayments += 1;
    }
}
