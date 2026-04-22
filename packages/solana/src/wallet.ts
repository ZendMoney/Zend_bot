import {
  Keypair,
  Connection,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAccount,
} from '@solana/spl-token';
import { SOLANA_TOKENS } from '@zend/shared';

export class WalletService {
  private connection: Connection;
  private feePayer: Keypair;

  constructor(rpcUrl: string, feePayerSecret: Uint8Array) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.feePayer = Keypair.fromSecretKey(feePayerSecret);
  }

  // Generate a new Solana wallet for a user
  generateWallet(): { publicKey: string; secretKey: Uint8Array } {
    const keypair = Keypair.generate();
    return {
      publicKey: keypair.publicKey.toBase58(),
      secretKey: keypair.secretKey,
    };
  }

  // Get SOL balance
  async getSolBalance(address: string): Promise<number> {
    const pubkey = new PublicKey(address);
    const balance = await this.connection.getBalance(pubkey);
    return balance / LAMPORTS_PER_SOL;
  }

  // Get SPL token balance (USDT, USDC, etc.)
  async getTokenBalance(walletAddress: string, mintAddress: string): Promise<number> {
    const walletPubkey = new PublicKey(walletAddress);
    const mintPubkey = new PublicKey(mintAddress);
    
    const tokenAccount = await getAssociatedTokenAddress(mintPubkey, walletPubkey);
    
    try {
      const account = await getAccount(this.connection, tokenAccount);
      const token = Object.values(SOLANA_TOKENS).find(t => t.mint === mintAddress);
      const decimals = token?.decimals || 6;
      return Number(account.amount) / Math.pow(10, decimals);
    } catch {
      // Token account doesn't exist yet
      return 0;
    }
  }

  // Get all token balances for a wallet
  async getAllBalances(walletAddress: string) {
    const [solBalance, usdtBalance, usdcBalance] = await Promise.all([
      this.getSolBalance(walletAddress),
      this.getTokenBalance(walletAddress, SOLANA_TOKENS.USDT.mint),
      this.getTokenBalance(walletAddress, SOLANA_TOKENS.USDC.mint),
    ]);

    return [
      { ...SOLANA_TOKENS.SOL, amount: solBalance },
      { ...SOLANA_TOKENS.USDT, amount: usdtBalance },
      { ...SOLANA_TOKENS.USDC, amount: usdcBalance },
    ];
  }

  // Build and sign a transaction (fee payer pays gas, user wallet authorizes)
  async signAndSend(
    userWallet: Keypair,
    instructions: TransactionInstruction[],
    priorityFeeMicroLamports = 0
  ): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();

    const allInstructions: TransactionInstruction[] = [];

    // Add priority fee if specified
    if (priorityFeeMicroLamports > 0) {
      allInstructions.push(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityFeeMicroLamports,
        })
      );
    }

    allInstructions.push(...instructions);

    const messageV0 = new TransactionMessage({
      payerKey: this.feePayer.publicKey,
      recentBlockhash: blockhash,
      instructions: allInstructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    
    // Both sign: fee payer pays for gas, user wallet authorizes the action
    transaction.sign([this.feePayer, userWallet]);

    const signature = await this.connection.sendTransaction(transaction, {
      maxRetries: 3,
      skipPreflight: false,
    });

    // Wait for confirmation
    await this.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed'
    );

    return signature;
  }

  // Send SPL tokens (USDT, USDC) to a recipient
  async sendSplToken(
    userWallet: Keypair,
    recipientAddress: string,
    mintAddress: string,
    amount: number,
    decimals: number
  ): Promise<string> {
    const mintPubkey = new PublicKey(mintAddress);
    const recipientPubkey = new PublicKey(recipientAddress);
    const senderTokenAccount = await getAssociatedTokenAddress(mintPubkey, userWallet.publicKey);
    const recipientTokenAccount = await getAssociatedTokenAddress(mintPubkey, recipientPubkey);

    const rawAmount = BigInt(Math.round(amount * Math.pow(10, decimals)));

    const instructions: TransactionInstruction[] = [
      // Ensure recipient token account exists
      createAssociatedTokenAccountIdempotentInstruction(
        this.feePayer.publicKey,
        recipientTokenAccount,
        recipientPubkey,
        mintPubkey
      ),
      // Transfer tokens
      createTransferInstruction(
        senderTokenAccount,
        recipientTokenAccount,
        userWallet.publicKey,
        rawAmount
      ),
    ];

    return this.signAndSend(userWallet, instructions);
  }

  // Send USDT specifically
  async sendUsdt(
    userWallet: Keypair,
    recipientAddress: string,
    amount: number
  ): Promise<string> {
    return this.sendSplToken(
      userWallet,
      recipientAddress,
      SOLANA_TOKENS.USDT.mint,
      amount,
      SOLANA_TOKENS.USDT.decimals
    );
  }

  // Send USDC specifically
  async sendUsdc(
    userWallet: Keypair,
    recipientAddress: string,
    amount: number
  ): Promise<string> {
    return this.sendSplToken(
      userWallet,
      recipientAddress,
      SOLANA_TOKENS.USDC.mint,
      amount,
      SOLANA_TOKENS.USDC.decimals
    );
  }

  // Get fee payer balance (monitor this!)
  async getFeePayerBalance(): Promise<number> {
    const balance = await this.connection.getBalance(this.feePayer.publicKey);
    return balance / LAMPORTS_PER_SOL;
  }
}
