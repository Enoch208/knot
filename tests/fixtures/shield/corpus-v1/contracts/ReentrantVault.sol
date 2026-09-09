pragma solidity 0.8.28;

contract ReentrantVault {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "balance");
        (bool success,) = msg.sender.call{value: amount}("");
        require(success, "transfer");
        balances[msg.sender] -= amount;
    }
}
