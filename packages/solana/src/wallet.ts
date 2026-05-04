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

    // Re-fetch blockhash in case the original expired
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();

    // Update blockhash
    const message = TransactionMessage.decompile(transaction.message);
    message.recentBlockhash = blockhash;
    const newMessage = message.compileToV0Message();

    const newTx = new VersionedTransaction(newMessage);
    newTx.sign([userWallet]);

    const signature = await this.connection.sendTransaction(newTx, {
      maxRetries: 3,
      skipPreflight: false,
    });

    await this.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed'
    );

    return signature;
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
    const recipientTokenAccount = await getAssociatedTokenAddress(mintPubkey, recipientPubkey);

    const rawAmount = BigInt(Math.round(amount * Math.pow(10, decimals)));

    const instructions: TransactionInstruction[] = [
      // Ensure recipient token account exists (user pays for this ATA creation)
      createAssociatedTokenAccountIdempotentInstruction(
        userWallet.publicKey, // user pays
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

  // Check if user has enough SOL for gas
  async hasEnoughSolForGas(walletAddress: string, minSol = 0.001): Promise<boolean> {
    const balance = await this.getSolBalance(walletAddress);
    return balance >= minSol;
  }


}
