import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotOwnedException extends DomainException {
  constructor() {
    super('VIDEO_NOT_OWNED', 403, 'You do not own this video');
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super(
      'VIDEO_NOT_READY',
      409,
      'Video is not ready for streaming or download yet',
    );
  }
}

export class UploadAlreadyCompletedException extends DomainException {
  constructor() {
    super(
      'UPLOAD_ALREADY_COMPLETED',
      409,
      'Upload has already been completed for this video',
    );
  }
}
