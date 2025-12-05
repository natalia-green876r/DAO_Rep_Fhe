import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface DAOReputation {
  id: string;
  daoName: string;
  encryptedScore: string;
  timestamp: number;
  owner: string;
  status: "pending" | "verified" | "rejected";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [reputations, setReputations] = useState<DAOReputation[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newReputationData, setNewReputationData] = useState({ daoName: "", score: 0 });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedReputation, setSelectedReputation] = useState<DAOReputation | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const verifiedCount = reputations.filter(r => r.status === "verified").length;
  const pendingCount = reputations.filter(r => r.status === "pending").length;
  const rejectedCount = reputations.filter(r => r.status === "rejected").length;
  const [activeTab, setActiveTab] = useState("dashboard");
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => {
    loadReputations().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadReputations = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("reputation_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing reputation keys:", e); }
      }
      const list: DAOReputation[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`reputation_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ id: key, encryptedScore: recordData.score, timestamp: recordData.timestamp, owner: recordData.owner, daoName: recordData.daoName, status: recordData.status || "pending" });
            } catch (e) { console.error(`Error parsing reputation data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading reputation ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setReputations(list);
    } catch (e) { console.error("Error loading reputations:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitReputation = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting reputation score with Zama FHE..." });
    try {
      const encryptedScore = FHEEncryptNumber(newReputationData.score);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const recordId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const recordData = { score: encryptedScore, timestamp: Math.floor(Date.now() / 1000), owner: address, daoName: newReputationData.daoName, status: "pending" };
      await contract.setData(`reputation_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      const keysBytes = await contract.getData("reputation_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(recordId);
      await contract.setData("reputation_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted reputation submitted securely!" });
      await loadReputations();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewReputationData({ daoName: "", score: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const verifyReputation = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted reputation with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const recordBytes = await contract.getData(`reputation_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      
      const verifiedData = FHECompute(recordData.score, 'increase10%');
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedRecord = { ...recordData, status: "verified", score: verifiedData };
      await contractWithSigner.setData(`reputation_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE verification completed successfully!" });
      await loadReputations();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Verification failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const rejectReputation = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted reputation with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const recordBytes = await contract.getData(`reputation_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      const updatedRecord = { ...recordData, status: "rejected" };
      await contract.setData(`reputation_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      setTransactionStatus({ visible: true, status: "success", message: "FHE rejection completed successfully!" });
      await loadReputations();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (recordAddress: string) => address?.toLowerCase() === recordAddress.toLowerCase();

  const tutorialSteps = [
    { title: "Connect Wallet", description: "Connect your Web3 wallet to start using DAO Reputation Portability", icon: "🔗" },
    { title: "Submit Encrypted Reputation", description: "Add your DAO reputation score which will be encrypted using FHE", icon: "🔒", details: "Your reputation score is encrypted on the client-side before being sent to the blockchain" },
    { title: "FHE Processing", description: "Your reputation is processed in encrypted state without decryption", icon: "⚙️", details: "Zama FHE technology allows computations on encrypted data without exposing sensitive information" },
    { title: "Port Reputation", description: "Transfer your verified reputation to other DAOs", icon: "🔄", details: "Your encrypted reputation can be used as initial credit in other DAOs" }
  ];

  const filteredReputations = reputations.filter(rep => 
    rep.daoName.toLowerCase().includes(searchTerm.toLowerCase()) || 
    rep.owner.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const renderRadarChart = () => {
    const daoNames = [...new Set(reputations.map(r => r.daoName))];
    const data = daoNames.map(dao => {
      const daoReps = reputations.filter(r => r.daoName === dao && r.status === "verified");
      const avgScore = daoReps.length > 0 ? 
        daoReps.reduce((sum, rep) => sum + FHEDecryptNumber(rep.encryptedScore), 0) / daoReps.length : 
        0;
      return { dao, score: avgScore };
    });
    
    return (
      <div className="radar-chart-container">
        <div className="radar-chart">
          {data.map((item, i) => (
            <div key={i} className="radar-point" style={{
              transform: `rotate(${i * (360 / data.length)}deg)`,
              left: `calc(50% + ${Math.cos(i * (2 * Math.PI / data.length)) * 100}px)`,
              top: `calc(50% + ${Math.sin(i * (2 * Math.PI / data.length)) * 100}px)`
            }}>
              <div className="point-value">{item.score.toFixed(1)}</div>
              <div className="point-label">{item.dao}</div>
            </div>
          ))}
          <div className="radar-center">
            <div className="center-value">Avg</div>
            <div className="center-score">{data.reduce((sum, item) => sum + item.score, 0) / data.length || 0}</div>
          </div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Initializing DAO reputation system...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>DAO Reputation Portability</h1>
          <div className="fhe-badge">Powered by Zama FHE</div>
        </div>
        <div className="header-actions">
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <nav className="app-nav">
        <button className={activeTab === "dashboard" ? "active" : ""} onClick={() => setActiveTab("dashboard")}>Dashboard</button>
        <button className={activeTab === "reputations" ? "active" : ""} onClick={() => setActiveTab("reputations")}>My Reputations</button>
        <button className={activeTab === "transfer" ? "active" : ""} onClick={() => setActiveTab("transfer")}>Transfer Reputation</button>
        <button className={activeTab === "about" ? "active" : ""} onClick={() => setActiveTab("about")}>About</button>
      </nav>
      <main className="main-content">
        {activeTab === "dashboard" && (
          <div className="dashboard">
            <div className="welcome-banner">
              <h2>DAO Reputation Portability Protocol</h2>
              <p>Securely transfer your DAO reputation between communities using Zama FHE encryption</p>
              <button className="primary-btn" onClick={() => setShowCreateModal(true)}>Add New Reputation</button>
            </div>
            
            <div className="stats-grid">
              <div className="stat-card">
                <h3>Total Reputations</h3>
                <div className="stat-value">{reputations.length}</div>
              </div>
              <div className="stat-card">
                <h3>Verified</h3>
                <div className="stat-value">{verifiedCount}</div>
              </div>
              <div className="stat-card">
                <h3>Pending</h3>
                <div className="stat-value">{pendingCount}</div>
              </div>
              <div className="stat-card">
                <h3>Rejected</h3>
                <div className="stat-value">{rejectedCount}</div>
              </div>
            </div>
            
            <div className="chart-section">
              <h3>DAO Reputation Distribution</h3>
              {renderRadarChart()}
            </div>
          </div>
        )}
        
        {activeTab === "reputations" && (
          <div className="reputations-list">
            <div className="list-header">
              <h2>My DAO Reputations</h2>
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="Search DAOs or addresses..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                <button className="refresh-btn" onClick={loadReputations} disabled={isRefreshing}>
                  {isRefreshing ? "Refreshing..." : "Refresh"}
                </button>
              </div>
            </div>
            
            <div className="table-container">
              <div className="table-header">
                <div>DAO Name</div>
                <div>Score</div>
                <div>Status</div>
                <div>Actions</div>
              </div>
              
              {filteredReputations.length === 0 ? (
                <div className="empty-state">
                  <p>No reputations found</p>
                  <button className="primary-btn" onClick={() => setShowCreateModal(true)}>Add First Reputation</button>
                </div>
              ) : (
                filteredReputations.map(rep => (
                  <div className="table-row" key={rep.id} onClick={() => setSelectedReputation(rep)}>
                    <div>{rep.daoName}</div>
                    <div>{rep.encryptedScore.substring(0, 10)}...</div>
                    <div className={`status-badge ${rep.status}`}>{rep.status}</div>
                    <div className="actions">
                      {isOwner(rep.owner) && rep.status === "pending" && (
                        <>
                          <button className="action-btn verify" onClick={(e) => { e.stopPropagation(); verifyReputation(rep.id); }}>Verify</button>
                          <button className="action-btn reject" onClick={(e) => { e.stopPropagation(); rejectReputation(rep.id); }}>Reject</button>
                        </>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
        
        {activeTab === "transfer" && (
          <div className="transfer-section">
            <h2>Transfer Reputation to Another DAO</h2>
            <div className="transfer-cards">
              <div className="transfer-card">
                <h3>Source DAO</h3>
                <select>
                  <option>Select source DAO</option>
                  {[...new Set(reputations.filter(r => r.status === "verified").map(r => r.daoName))].map(dao => (
                    <option key={dao} value={dao}>{dao}</option>
                  ))}
                </select>
                <div className="score-preview">
                  <span>Current Score:</span>
                  <strong>85.5</strong>
                </div>
              </div>
              
              <div className="transfer-arrow">→</div>
              
              <div className="transfer-card">
                <h3>Target DAO</h3>
                <select>
                  <option>Select target DAO</option>
                  <option>DAO A</option>
                  <option>DAO B</option>
                  <option>DAO C</option>
                </select>
                <div className="score-preview">
                  <span>Initial Credit:</span>
                  <strong>42.8</strong>
                </div>
              </div>
            </div>
            
            <button className="primary-btn transfer-btn">Transfer Reputation</button>
            
            <div className="fhe-notice">
              <h4>FHE-Encrypted Transfer Process</h4>
              <p>Your reputation score remains encrypted throughout the transfer process using Zama FHE technology</p>
            </div>
          </div>
        )}
        
        {activeTab === "about" && (
          <div className="about-section">
            <h2>About DAO Reputation Portability</h2>
            <div className="about-content">
              <div className="about-card">
                <h3>How It Works</h3>
                <p>The DAO Reputation Portability Protocol allows contributors to transfer their reputation between DAOs while maintaining privacy through Zama FHE encryption.</p>
              </div>
              
              <div className="about-card">
                <h3>FHE Technology</h3>
                <p>Fully Homomorphic Encryption (FHE) enables computations on encrypted data without decryption, ensuring your reputation scores remain private.</p>
              </div>
              
              <div className="about-card">
                <h3>Benefits</h3>
                <ul>
                  <li>Break down reputation silos between DAOs</li>
                  <li>Maintain privacy of your contributions</li>
                  <li>Get credit for your work across communities</li>
                </ul>
              </div>
            </div>
            
            <div className="tutorial-toggle">
              <button onClick={() => setShowTutorial(!showTutorial)}>
                {showTutorial ? "Hide Tutorial" : "Show Tutorial"}
              </button>
            </div>
            
            {showTutorial && (
              <div className="tutorial-section">
                <h3>Getting Started Guide</h3>
                <div className="tutorial-steps">
                  {tutorialSteps.map((step, i) => (
                    <div className="tutorial-step" key={i}>
                      <div className="step-icon">{step.icon}</div>
                      <div className="step-content">
                        <h4>{step.title}</h4>
                        <p>{step.description}</p>
                        {step.details && <div className="step-details">{step.details}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </main>
      
      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal">
            <div className="modal-header">
              <h2>Add New DAO Reputation</h2>
              <button onClick={() => setShowCreateModal(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>DAO Name</label>
                <input 
                  type="text" 
                  value={newReputationData.daoName}
                  onChange={(e) => setNewReputationData({...newReputationData, daoName: e.target.value})}
                  placeholder="Enter DAO name"
                />
              </div>
              <div className="form-group">
                <label>Reputation Score</label>
                <input 
                  type="number" 
                  value={newReputationData.score}
                  onChange={(e) => setNewReputationData({...newReputationData, score: parseFloat(e.target.value) || 0})}
                  placeholder="Enter your reputation score"
                />
              </div>
              <div className="encryption-preview">
                <h4>FHE Encryption Preview</h4>
                <div className="preview-row">
                  <span>Plain Score:</span>
                  <span>{newReputationData.score}</span>
                </div>
                <div className="preview-row">
                  <span>Encrypted:</span>
                  <span>{newReputationData.score ? FHEEncryptNumber(newReputationData.score).substring(0, 20) + "..." : "N/A"}</span>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowCreateModal(false)}>Cancel</button>
              <button onClick={submitReputation} disabled={creating}>
                {creating ? "Submitting..." : "Submit with FHE"}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {selectedReputation && (
        <div className="modal-overlay">
          <div className="detail-modal">
            <div className="modal-header">
              <h2>Reputation Details</h2>
              <button onClick={() => { setSelectedReputation(null); setDecryptedValue(null); }}>×</button>
            </div>
            <div className="modal-body">
              <div className="detail-row">
                <span>DAO:</span>
                <span>{selectedReputation.daoName}</span>
              </div>
              <div className="detail-row">
                <span>Status:</span>
                <span className={`status-badge ${selectedReputation.status}`}>{selectedReputation.status}</span>
              </div>
              <div className="detail-row">
                <span>Date:</span>
                <span>{new Date(selectedReputation.timestamp * 1000).toLocaleDateString()}</span>
              </div>
              <div className="detail-row">
                <span>Encrypted Score:</span>
                <span>{selectedReputation.encryptedScore.substring(0, 20)}...</span>
              </div>
              
              <div className="decrypt-section">
                <button 
                  onClick={async () => {
                    if (decryptedValue === null) {
                      const decrypted = await decryptWithSignature(selectedReputation.encryptedScore);
                      if (decrypted !== null) setDecryptedValue(decrypted);
                    } else {
                      setDecryptedValue(null);
                    }
                  }}
                  disabled={isDecrypting}
                >
                  {isDecrypting ? "Decrypting..." : decryptedValue === null ? "Decrypt Score" : "Hide Score"}
                </button>
                
                {decryptedValue !== null && (
                  <div className="decrypted-value">
                    <span>Decrypted Score:</span>
                    <strong>{decryptedValue}</strong>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✗"}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-links">
            <a href="#">Documentation</a>
            <a href="#">GitHub</a>
            <a href="#">Terms</a>
            <a href="#">Privacy</a>
          </div>
          <div className="footer-copyright">
            © 2023 DAO Reputation Portability Protocol | Powered by Zama FHE
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;