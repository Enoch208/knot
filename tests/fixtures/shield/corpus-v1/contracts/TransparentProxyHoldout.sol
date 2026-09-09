pragma solidity 0.8.28;

contract TransparentProxyHoldout {
    bytes32 private constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 private constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e0196a0a2e8ee1178d6a717850b5d6103;

    constructor(address implementationAddress, address adminAddress) {
        assembly {
            sstore(IMPLEMENTATION_SLOT, implementationAddress)
            sstore(ADMIN_SLOT, adminAddress)
        }
    }

    function upgradeToAndCall(address nextImplementation, bytes calldata data) external payable {
        address adminAddress;
        assembly {
            adminAddress := sload(ADMIN_SLOT)
        }
        require(msg.sender == adminAddress, "admin");
        assembly {
            sstore(IMPLEMENTATION_SLOT, nextImplementation)
        }
        if (data.length > 0) {
            (bool success,) = nextImplementation.delegatecall(data);
            require(success, "initialization");
        }
    }

    fallback() external payable {
        address implementationAddress;
        assembly {
            implementationAddress := sload(IMPLEMENTATION_SLOT)
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), implementationAddress, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
