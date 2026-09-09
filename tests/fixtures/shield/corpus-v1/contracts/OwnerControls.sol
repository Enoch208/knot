pragma solidity 0.8.28;

contract OwnerControls {
    address public owner;
    bool public paused;
    mapping(address => uint256) public balances;

    constructor() {
        owner = msg.sender;
    }

    function mint(address recipient, uint256 amount) external {
        require(msg.sender == owner, "owner");
        balances[recipient] += amount;
    }

    function pause() external {
        require(msg.sender == owner, "owner");
        paused = true;
    }
}
