pragma solidity 0.8.28;

contract SafeVault {
    mapping(address => uint256) public balances;
    bool private entered;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(!entered, "reentry");
        require(balances[msg.sender] >= amount, "balance");
        entered = true;
        balances[msg.sender] -= amount;
        (bool success,) = msg.sender.call{value: amount}("");
        require(success, "transfer");
        entered = false;
    }
}
