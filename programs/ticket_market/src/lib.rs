use anchor_lang::prelude::*;

// Fix the program ID to match your JSON
declare_id!("GRb8e96kJJvofUenMx6QM7mRu9mwKCdzY6KC4PGTD3KL");

#[program]
pub mod ticket_market {
    use super::*;

    // Create a new ticket (by event organizer)
    pub fn create_ticket(
        ctx: Context<CreateTicket>,
        price: u64,
        resale_allowed: bool,
        max_markup: u8, // % max markup on resale (e.g., 20 = 20%)
        mint: Pubkey,   // Add mint address parameter
    ) -> Result<()> {
        let ticket = &mut ctx.accounts.ticket;
        ticket.owner = *ctx.accounts.organizer.key;
        ticket.price = price;
        ticket.resale_allowed = resale_allowed;
        ticket.max_markup = max_markup;
        ticket.original_price = price;
        ticket.is_listed = false;
        ticket.mint = mint; // Store the mint address
        Ok(())
    }

    // List ticket for resale
    pub fn list_ticket(ctx: Context<ListTicket>, new_price: u64) -> Result<()> {
        let ticket = &mut ctx.accounts.ticket;

        require!(ticket.resale_allowed, TicketError::ResaleNotAllowed);
        require!(
            ticket.owner == *ctx.accounts.owner.key,
            TicketError::NotTicketOwner
        );

        // Enforce max markup % limit
        let max_allowed_price =
            ticket.original_price + (ticket.original_price * ticket.max_markup as u64 / 100);
        require!(
            new_price <= max_allowed_price,
            TicketError::ExceedsMaxMarkup
        );

        ticket.price = new_price;
        ticket.is_listed = true;

        Ok(())
    }

    // Buy ticket
    pub fn buy_ticket(ctx: Context<BuyTicket>) -> Result<()> {
        let ticket = &mut ctx.accounts.ticket;

        require!(ticket.is_listed, TicketError::TicketNotListed);

        // Transfer lamports (simplified for Playground)
        **ctx
            .accounts
            .buyer
            .to_account_info()
            .try_borrow_mut_lamports()? -= ticket.price;
        **ctx
            .accounts
            .owner
            .to_account_info()
            .try_borrow_mut_lamports()? += ticket.price;

        ticket.owner = *ctx.accounts.buyer.key;
        ticket.is_listed = false;

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(price: u64, resale_allowed: bool, max_markup: u8, mint: Pubkey)]
pub struct CreateTicket<'info> {
    #[account(
        init,
        payer = organizer,
        space = 8 + Ticket::LEN,
        seeds = [b"ticket", organizer.key().as_ref(), mint.as_ref()],
        bump
    )]
    pub ticket: Account<'info, Ticket>,

    #[account(mut)]
    pub organizer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ListTicket<'info> {
    #[account(mut)]
    pub ticket: Account<'info, Ticket>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct BuyTicket<'info> {
    #[account(mut)]
    pub ticket: Account<'info, Ticket>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Ticket {
    pub owner: Pubkey,        // 32
    pub price: u64,           // 8
    pub resale_allowed: bool, // 1
    pub max_markup: u8,       // 1
    pub original_price: u64,  // 8
    pub is_listed: bool,      // 1
    pub mint: Pubkey,         // 32 - Add mint field
}

impl Ticket {
    pub const LEN: usize = 32 + 8 + 1 + 1 + 8 + 1 + 32; // Updated length
}

#[error_code]
pub enum TicketError {
    #[msg("Ticket resale is not allowed.")]
    ResaleNotAllowed,
    #[msg("You are not the ticket owner.")]
    NotTicketOwner,
    #[msg("Price exceeds allowed markup.")]
    ExceedsMaxMarkup,
    #[msg("Ticket is not listed for sale.")]
    TicketNotListed,
}