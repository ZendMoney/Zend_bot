import {
  Keypair,
  Connection,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
import { SOLANA_TOKENS } from '../../shared/src/constants.js';

export class WalletService {
  private connection: Connection;

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, 'confirmed');
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

  // Build and sign a transaction (user pays gas with their own SOL)
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
      payerKey: userWallet.publicKey, // USER pays gas
      recentBlockhash: blockhash,
      instructions: allInstructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    
    // User signs alone — they pay gas AND authorize the action
    transaction.sign([userWallet]);

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

  // Sign and send a serialized VersionedTransaction (base64)
  // Used for Jupiter swaps and other dApp integrations
  async signAndSendSerialized(
    userWallet: Keypair,
    serializedTx: string
  ): Promise<string> {
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(serializedTx, 'base64')
    );

    // Jupiter already sets a valid blockhash in the serialized tx.
    // Don't decompile/recompile — LUT-based transactions fail on decompile.
    transaction.sign([userWallet]);

    const signature = await this.connection.sendTransaction(transaction, {
      maxRetries: 3,
      skipPreflight: false,
    });

    await this.connection.confirmTransaction(signature, 'confirmed');

    return signature;
  }

  // Check if an address is already a token account (not a wallet)
  private async isTokenAccount(address: string): Promise<boolean> {
    try {
      const pubkey = new PublicKey(address);
      const accountInfo = await this.connection.getAccountInfo(pubkey);
      if (!accountInfo) return false;
      // Support both legacy SPL Token and Token-2022 programs
      return accountInfo.owner.equals(TOKEN_PROGRAM_ID) || accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
    } catch {
      return false;
    }
  }

  // Send SPL tokens (USDT, USDC) to a recipient
  // NOTE: User must have SOL for gas. Zend can optionally fund their wallet on first deposit.
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

    // ─── Check sender has enough balance ───
    let senderBalance = 0;
    try {
      const account = await getAccount(this.connection, senderTokenAccount);
      senderBalance = Number(account.amount) / Math.pow(10, decimals);
    } catch {
      throw new Error(`You don't have a ${mintAddress.slice(0, 6)}... token account yet. Please deposit tokens first.`);
    }

    if (senderBalance < amount) {
      throw new Error(`Insufficient balance. You have ${senderBalance.toFixed(decimals)} but need ${amount.toFixed(decimals)}.`);
    }

    const rawAmount = BigInt(Math.round(amount * Math.pow(10, decimals)));
    const instructions: TransactionInstruction[] = [];

    // ─── Detect if recipient is a token account or wallet ───
    const recipientIsTokenAccount = await this.isTokenAccount(recipientAddress);

    if (recipientIsTokenAccount) {
      // Recipient is already a token account — transfer directly
      instructions.push(
        createTransferInstruction(
          senderTokenAccount,
          recipientPubkey, // recipient is the token account itself
          userWallet.publicKey,
          rawAmount
        )
      );
    } else {
      // Recipient is a wallet — compute ATA and create if needed
      const recipientTokenAccount = await getAssociatedTokenAddress(mintPubkey, recipientPubkey);
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          userWallet.publicKey,
          recipientTokenAccount,
          recipientPubkey,
          mintPubkey
        ),
        createTransferInstruction(
          senderTokenAccount,
          recipientTokenAccount,
          userWallet.publicKey,
          rawAmount
        )
      );
    }

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

  // Send raw SOL (used for gas sponsorship from dev wallet)
  async sendSol(
    senderWallet: Keypair,
    recipientAddress: string,
    amountSol: number
  ): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    const recipientPubkey = new PublicKey(recipientAddress);
    const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);

    const instructions: TransactionInstruction[] = [];
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: senderWallet.publicKey,
        toPubkey: recipientPubkey,
        lamports,
      })
    );

    const messageV0 = new TransactionMessage({
      payerKey: senderWallet.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([senderWallet]);

    const signature = await this.connection.sendTransaction(transaction, {
      maxRetries: 3,
      skipPreflight: false,
    });

    await this.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed'
    );

    return signature;
  }

  // Check if user has enough SOL for gas
  async hasEnoughSolForGas(walletAddress: string, minSol = 0.001): Promise<boolean> {
    const balance = await this.getSolBalance(walletAddress);
    return balance >= minSol;
  }


}
