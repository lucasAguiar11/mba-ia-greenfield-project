import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class CreateVideoUploadDto {
  @IsString()
  @IsNotEmpty()
  filename: string;

  @IsString()
  @IsNotEmpty()
  content_type: string;

  @IsInt()
  @Min(1)
  size_bytes: number;
}
