import { IsString, IsNotEmpty, IsNumber, IsIn, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePledgeDto {
  @IsString()
  @IsNotEmpty()
  debtorUsername: string;

  /** Amount in token's smallest unit, as a decimal string (avoids JS bigint loss) */
  @IsString()
  @IsNotEmpty()
  amount: string;

  /** ERC-20 token address */
  @IsString()
  @IsNotEmpty()
  token: string;

  /** Unix timestamp (seconds) */
  @IsNumber()
  @Type(() => Number)
  @Min(1)
  dueTimestamp: number;

  @IsIn(['Voluntary', 'Enforced'])
  track: 'Voluntary' | 'Enforced';
}
