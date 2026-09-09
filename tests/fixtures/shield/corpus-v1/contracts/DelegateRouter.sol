pragma solidity 0.8.28;

contract DelegateRouter {
    address public owner;
    address public implementation;

    constructor(address initialImplementation) {
        owner = msg.sender;
        implementation = initialImplementation;
    }

    function setImplementation(address nextImplementation) external {
        require(msg.sender == owner, "owner");
        implementation = nextImplementation;
    }

    fallback() external payable {
        address target = implementation;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), target, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
